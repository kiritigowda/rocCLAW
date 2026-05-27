// MIT License - Copyright (c) 2026 kiritigowda
// See LICENSE file for details.

/**
 * ROCm GPU Detection and Metrics Module
 * Detects rocminfo/rocm-smi and provides GPU information
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";

const execAsync = promisify(exec);

export interface ROCmGPUInfo {
  index: number;
  name: string;
  marketingName: string;
  vendor: string;
  deviceType: "GPU" | "CPU";
  gfxVersion: string;
  computeUnits: number;
  maxClockMHz: number;
  // Extended info from rocm-smi -a
  deviceId?: string;
  driverVersion?: string;
  vbiosVersion?: string;
  deviceRev?: string;
  subsystemId?: string;
  guid?: string;
  pciBus?: string;
  memory?: {
    total: number; // GB
    used: number; // GB
  };
  usage?: number; // percentage
  temperature?: number; // celsius
  power?: number; // watts
  currentClockMHz?: number;
}

interface ROCmSystemInfo {
  runtimeVersion: string;
  gpus: ROCmGPUInfo[];
  detected: boolean;
  rocmInfoPath?: string;
  rocmSmiPath?: string;
}

/**
 * Read a sysfs file safely, returning null on error
 */
async function readSysfsFile(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return null;
  }
}

/**
 * Find DRM device path for a GPU by PCI bus address.
 * Accepts either "domain:bus:device.function" (e.g. "0000:65:00.0")
 * or "bus:device.function" (e.g. "65:00.0").
 */
async function findDrmDeviceForPciBus(pciBus: string): Promise<string | null> {
  // Normalize: strip domain prefix if present so "0000:65:00.0" becomes "65:00.0"
  const normalizedBus = pciBus.replace(/^[0-9a-f]{4}:/i, "");

  try {
    const { stdout } = await execAsync("ls /sys/class/drm/ 2>/dev/null");
    const cards = stdout.split("\n").filter((l) => l.startsWith("card") && !l.includes("-"));

    for (const card of cards) {
      const devicePath = `/sys/class/drm/${card}/device`;
      const ueventPath = await readSysfsFile(join(devicePath, "uevent"));

      // PCI_SLOT_NAME in uevent is like "0000:65:00.0"
      // Match against both the full and normalized bus strings
      if (ueventPath?.includes(pciBus) || ueventPath?.includes(normalizedBus)) {
        return devicePath;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Read GPU temperature from sysfs hwmon (works for amdgpu driver)
 */
async function getSysfsTemperature(drmPath: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `ls ${drmPath}/hwmon/ 2>/dev/null`
    );
    const hwmonDir = stdout.trim().split("\n")[0];
    if (hwmonDir) {
      const tempStr = await readSysfsFile(
        join(drmPath, "hwmon", hwmonDir, "temp1_input")
      );
      if (tempStr) {
        return parseInt(tempStr, 10) / 1000; // Convert millidegrees to C
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Read GPU usage from sysfs (amdgpu gpu_busy_percent)
 */
async function getSysfsGpuUsage(drmPath: string): Promise<number | null> {
  const busyStr = await readSysfsFile(join(drmPath, "gpu_busy_percent"));
  if (busyStr) {
    return parseInt(busyStr, 10);
  }
  return null;
}

/**
 * Read GPU memory info from sysfs (amdgpu mem_info_vram_*)
 */
async function getSysfsGpuMemory(drmPath: string): Promise<{ total: number; used: number } | null> {
  const [totalStr, usedStr] = await Promise.all([
    readSysfsFile(join(drmPath, "mem_info_vram_total")),
    readSysfsFile(join(drmPath, "mem_info_vram_used")),
  ]);

  if (totalStr) {
    const total = parseInt(totalStr, 10);
    const used = usedStr ? parseInt(usedStr, 10) : 0;
    return {
      total: Math.round(total / (1024 * 1024 * 1024) * 100) / 100, // GB
      used: Math.round(used / (1024 * 1024 * 1024) * 100) / 100,   // GB
    };
  }
  return null;
}

/**
 * Read GPU clock from sysfs (amdgpu pp_dpm_sclk)
 */
async function getSysfsCurrentClock(drmPath: string): Promise<number | null> {
  const sclkStr = await readSysfsFile(join(drmPath, "pp_dpm_sclk"));
  if (sclkStr) {
    const lines = sclkStr.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\d+):\s*(\d+)Mhz\s*\*\s*$/);
      if (match) {
        return parseInt(match[2], 10);
      }
    }
  }
  return null;
}

/**
 * Read GPU power from sysfs hwmon (amdgpu power1_average)
 */
async function getSysfsPower(drmPath: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `ls ${drmPath}/hwmon/ 2>/dev/null`
    );
    const hwmonDir = stdout.trim().split("\n")[0];
    if (hwmonDir) {
      const powerStr = await readSysfsFile(
        join(drmPath, "hwmon", hwmonDir, "power1_average")
      );
      if (powerStr) {
        // power1_average is in microwatts
        return Math.round(parseInt(powerStr, 10) / 1_000_000 * 100) / 100; // Convert to watts
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Fallback: enrich ROCm GPU info with sysfs data when rocm-smi is unavailable.
 * Reads temperature, usage, memory, clock, and power from DRM sysfs.
 * Matches by pciBus if available, otherwise by GPU index ordering.
 */
async function enrichWithSysfsFallback(gpu: ROCmGPUInfo, gpuIndex: number): Promise<void> {
  let drmPath: string | null = null;

  // Try PCI bus matching first (most reliable)
  if (gpu.pciBus) {
    drmPath = await findDrmDeviceForPciBus(gpu.pciBus);
  }

  // Fall back to index-based matching: enumerate DRM cards and pick by index
  if (!drmPath) {
    const allDrmPaths = await findAllDrmDevicePaths();
    // Filter to only GPU devices (render nodes and control nodes have different suffixes)
    const gpuPaths = allDrmPaths.filter((p) => !p.includes("-"));
    if (gpuIndex < gpuPaths.length) {
      drmPath = gpuPaths[gpuIndex];
    }
  }

  if (!drmPath) return;

  // Read metrics in parallel
  const [temperature, usage, memory, currentClock, power] = await Promise.all([
    getSysfsTemperature(drmPath),
    getSysfsGpuUsage(drmPath),
    getSysfsGpuMemory(drmPath),
    getSysfsCurrentClock(drmPath),
    getSysfsPower(drmPath),
  ]);

  if (temperature !== null) gpu.temperature = temperature;
  if (usage !== null) gpu.usage = usage;
  if (memory !== null) gpu.memory = memory;
  if (currentClock !== null) gpu.currentClockMHz = currentClock;
  if (power !== null) gpu.power = power;
}

/**
 * Enumerate all DRM device paths under /sys/class/drm/
 */
async function findAllDrmDevicePaths(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("ls /sys/class/drm/ 2>/dev/null");
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("card"))
      .map((card) => `/sys/class/drm/${card}/device`);
  } catch {
    return [];
  }
}

/**
 * Check if rocminfo is available in PATH or /opt/rocm
 */
async function findRocmInfo(): Promise<string | undefined> {
  const paths = [
    "/usr/bin/rocminfo",
    "/opt/rocm/bin/rocminfo",
    "/opt/rocm/latest/bin/rocminfo",
  ];

  for (const path of paths) {
    try {
      await execAsync(`test -x ${path}`);
      return path;
    } catch {
      continue;
    }
  }

  // Try PATH
  try {
    await execAsync("which rocminfo");
    return "rocminfo";
  } catch {
    return undefined;
  }
}

/**
 * Check if rocm-smi is available in PATH or /opt/rocm
 */
async function findRocmSmi(): Promise<string | undefined> {
  const paths = [
    "/usr/bin/rocm-smi",
    "/opt/rocm/bin/rocm-smi",
    "/opt/rocm/latest/bin/rocm-smi",
  ];

  for (const path of paths) {
    try {
      await execAsync(`test -x ${path}`);
      return path;
    } catch {
      continue;
    }
  }

  // Try PATH
  try {
    await execAsync("which rocm-smi");
    return "rocm-smi";
  } catch {
    return undefined;
  }
}

/**
 * Get GPU name with marketing name and/or dynamic specs.
 * Hybrid approach: uses hardcoded marketing names when known,
 * falls back to dynamic description with detected specs.
 */
function getMarketingName(
  gfxVersion: string | undefined,
  gpu?: { computeUnits?: number; maxClockMHz?: number; deviceId?: string }
): string {
  if (!gfxVersion) return "AMD GPU";

  const gfxMap: Record<string, string> = {
    // RDNA 3.5 (gfx115x) - Strix Point / Strix Halo
    // gfx1151 can be 8060S (40 CUs) or 8050S (32 CUs) - differentiated by CU count
    "gfx1151": "AMD Radeon 8060S", // Full Strix Halo - 40 CUs (2560 SPs)
    "gfx1150": "AMD Radeon 890M",  // Strix Point iGPU - default to 890M
    // RDNA 3 (Radeon RX 7000 series)
    "gfx1100": "AMD Radeon RX 7900 XTX",
    "gfx1101": "AMD Radeon RX 7900 XT",
    "gfx1102": "AMD Radeon RX 7900 GRE",
    "gfx1103": "AMD Radeon RX 7800 XT",
    // RDNA 2 (Radeon RX 6000 series)
    "gfx1030": "AMD Radeon RX 6800 XT",
    "gfx1031": "AMD Radeon RX 6800",
    "gfx1032": "AMD Radeon RX 6700 XT",
    // RDNA 1 (Radeon RX 5000 series)
    "gfx1010": "AMD Radeon RX 5700 XT",
    "gfx1011": "AMD Radeon RX 5700",
    "gfx1012": "AMD Radeon RX 5600 XT",
    // Vega
    "gfx900": "AMD Radeon RX Vega",
    "gfx906": "AMD Radeon VII",
    // CDNA / Instinct
    "gfx908": "AMD Instinct MI100",
    "gfx90a": "AMD Instinct MI200",
    "gfx942": "AMD Instinct MI300",
  };

  let marketingName = gfxMap[gfxVersion];

  // Special handling for gfx1151: differentiate 8060S (40 CUs) vs 8050S (32 CUs)
  if (gfxVersion === "gfx1151" && gpu?.computeUnits) {
    if (gpu.computeUnits <= 34) {
      // 8050S is cut-down to 32 CUs (allow some margin for detection errors)
      marketingName = "AMD Radeon 8050S"; // 32 CUs (2048 SPs)
    } else {
      // 8060S has full 40 CUs
      marketingName = "AMD Radeon 8060S"; // 40 CUs (2560 SPs)
    }
  }

  // Special handling for gfx1150: differentiate 890M (16 CUs) vs 880M (12 CUs)
  if (gfxVersion === "gfx1150" && gpu?.computeUnits) {
    if (gpu.computeUnits <= 14) {
      // 880M is scaled-down to 12 CUs (allow some margin for detection errors)
      marketingName = "AMD Radeon 880M"; // 12 CUs
    } else {
      // 890M has full 16 CUs
      marketingName = "AMD Radeon 890M"; // 16 CUs (flagship)
    }
  }

  // If we have a known marketing name, return it without specs
  if (marketingName) {
    return marketingName;
  }

  // Unknown GPU - construct dynamic name from available data
  const specs: string[] = [gfxVersion];
  if (gpu?.deviceId) {
    specs.push(`Device ID: ${gpu.deviceId}`);
  }
  if (gpu?.computeUnits && gpu.computeUnits > 0) {
    specs.push(`${gpu.computeUnits} CUs`);
  }
  if (gpu?.maxClockMHz && gpu.maxClockMHz > 0) {
    specs.push(`${(gpu.maxClockMHz / 1000).toFixed(2)} GHz`);
  }
  return `AMD GPU (${specs.join(", ")})`;
}

/**
 * Map Device ID (PCI device ID) to the correct GFX version string.
 * rocminfo reports a generic gfx version per ASIC family, but the Device ID
 * uniquely identifies the specific GPU variant. For example, Strix Point (gfx1151)
 * reports gfx1100 in rocminfo but has Device ID 0x1502.
 * See: https://devicehunt.com/view/type/pci/vendor/1002/device/1502
 */
function resolveGfxVersion(deviceId: string | undefined, fallback: string): string {
  if (!deviceId) return fallback;
  // Normalize: strip leading "0x" and normalize to lowercase
  const id = deviceId.replace(/^0x/i, "").toLowerCase();
  const deviceToGfx: Record<string, string> = {
    // Strix Point (Ryzen AI 300 series) - Radeon 890M iGPU
    "1502": "gfx1151", // AMD Radeon AI MAX+ Pro 395 (Strix Halo - 40 CUs)
    "150e": "gfx1150", // AMD Radeon 890M (Strix Point iGPU - 16 CUs)
    "150f": "gfx1150", // AMD Radeon 890M (Strix Point iGPU - 16 CUs)
    "1586": "gfx1151", // AMD Radeon AI MAX+ Pro 395 (Strix Halo, alternate ID)
    // Strix Halo
    "1150": "gfx1151", // AMD Radeon AI MAX+ Pro 395 (Strix Halo)
    "1151": "gfx1151", // AMD Radeon AI MAX+ Pro 395 (Strix Halo)
    // RDNA 3 (Radeon RX 7000 series)
    "744c": "gfx1100", // AMD Radeon RX 7900 XTX
    "7440": "gfx1101", // AMD Radeon RX 7900 XT
    "7450": "gfx1102", // AMD Radeon RX 7900 GRE
    "743f": "gfx1103", // AMD Radeon RX 7800 XT
    // RDNA 2 (Radeon RX 6000 series)
    "73bf": "gfx1030", // AMD Radeon RX 6800 XT
    "73af": "gfx1031", // AMD Radeon RX 6800
    "73e1": "gfx1032", // AMD Radeon RX 6700 XT
    // RDNA 1 (Radeon RX 5000 series)
    "7310": "gfx1010", // AMD Radeon RX 5700 XT
    "731f": "gfx1011", // AMD Radeon RX 5700
    "731e": "gfx1012", // AMD Radeon RX 5600 XT
    // Vega
    "687f": "gfx900",  // AMD Radeon RX Vega
    "66a3": "gfx906",  // AMD Radeon VII
    // CDNA / Instinct
    "738c": "gfx908",  // AMD Instinct MI100
    "74a1": "gfx90a",  // AMD Instinct MI200
    "74a3": "gfx942",  // AMD Instinct MI300X
    // Older / other
    "68b8": "gfx803",  // AMD FirePro S7150
    "6900": "gfx803",  // AMD FirePro S7100
    "67e0": "gfx804",  // AMD FirePro W7100
  };
  return deviceToGfx[id] ?? fallback;
}

/**
 * Check if a GPU is likely an integrated GPU (iGPU) based on rocminfo data.
 * iGPUs typically have fewer CUs, lower clocks, and specific naming patterns.
 */
function isLikelyIGPU(gpu: ROCmGPUInfo, rawName: string | undefined): boolean {
  // Check for iGPU-specific naming patterns in the raw name from rocminfo
  if (rawName) {
    const name = rawName.toLowerCase();
    // Integrated GPUs often have these patterns
    if (name.includes("radeon graphics")) return true;
    if (name.includes("radeon 890")) return true;
    if (name.includes("radeon 880")) return true;
    if (name.includes("radeon 860")) return true;
    if (name.includes("radeon 840")) return true;
  }

  // Heuristic: iGPUs typically have <= 16 CUs (some high-end iGPUs have up to 16)
  // and lower max clock frequencies
  if (gpu.computeUnits <= 16 && gpu.maxClockMHz > 0 && gpu.maxClockMHz < 3000) {
    return true;
  }

  return false;
}

/**
 * Match GPU from rocminfo with GPU from rocm-smi using multiple criteria.
 * Returns the matching GPU from rocm-smi, or undefined if no confident match.
 */
function matchGpuWithSmiData(
  gpu: ROCmGPUInfo,
  smiData: Map<number, Partial<ROCmGPUInfo>>
): Partial<ROCmGPUInfo> | undefined {
  // First, try index match - but validate it makes sense
  const smiGpu = smiData.get(gpu.index);
  if (smiGpu && smiGpu.deviceId) {
    const deviceId = smiGpu.deviceId.toLowerCase();

    // Check if this device ID matches the expected GPU type
    // Based on compute units and clock, is this likely a discrete GPU?
    const likelyIGPU = isLikelyIGPU(gpu, gpu.name);
    const likelyDiscrete = !likelyIGPU;

    // RDNA 3 discrete GPU device IDs
    const isRdna3Discrete = deviceId === "0x744c" || deviceId === "0x7440" ||
                            deviceId === "0x7450" || deviceId === "0x743f";

    // Strix Point iGPU device IDs
    const isStrixPoint = deviceId === "0x1502" || deviceId === "0x150f" || deviceId === "0x1586";

    // If the device ID is a known Strix Point/Halo ID, accept the match
    // (Strix Halo can have 40 CUs which looks "discrete" by the heuristic,
    // but 0x1586/0x1502/0x150f are definitely Strix APUs)
    if (isStrixPoint) {
      return smiGpu;
    }

    // If rocminfo shows a high-end GPU but smi shows a low-end one, indices don't match
    if (likelyDiscrete && isStrixPoint) {
      // Index mismatch - this is likely a different GPU
      // Look for a better match
      for (const [, candidate] of smiData) {
        if (candidate.deviceId) {
          const candidateId = candidate.deviceId.toLowerCase();
          const candidateIsDiscrete = candidateId === "0x744c" || candidateId === "0x7440" ||
                                      candidateId === "0x7450" || candidateId === "0x743f";
          if (candidateIsDiscrete) {
            return candidate;
          }
        }
      }
      // No discrete GPU found in smi, return undefined
      return undefined;
    }

    // If it looks like a match, return it
    if ((likelyDiscrete && isRdna3Discrete) || (!likelyDiscrete && isStrixPoint)) {
      return smiGpu;
    }

    // When in doubt, prefer returning the data rather than nothing
    // but log that there might be a mismatch
    return smiGpu;
  }

  return undefined;
}

/**
 * Parse rocminfo output to extract GPU details
 */
function parseRocmInfo(output: string): ROCmGPUInfo[] {
  const gpus: ROCmGPUInfo[] = [];
  const agentBlocks = output.split("*******").filter((block) =>
    block.includes("Device Type:")
  );

  let gpuIndex = 0;
  for (const block of agentBlocks) {
    const deviceTypeMatch = block.match(/Device Type:\s*(\w+)/);
    const deviceType = deviceTypeMatch?.[1] || "Unknown";

    if (deviceType === "GPU") {
      const nameMatch = block.match(/Name:\s*(.+)/);
      const marketingNameMatch = block.match(/Marketing Name:\s*(.+)/);
      const vendorMatch = block.match(/Vendor Name:\s*(.+)/);
      // Try to find gfx version - look for the most specific one (longer is usually more specific)
      const gfxVersionMatches = [...block.matchAll(/Name:\s*(gfx\d+[a-z]*)/g)];
      const gfxVersionMatch = gfxVersionMatches.length > 0
        ? gfxVersionMatches[gfxVersionMatches.length - 1]  // Take the last match (usually the most specific)
        : null;
      const computeUnitsMatch = block.match(/Compute Unit:\s*(\d+)/);
      const maxClockMatch = block.match(/Max Clock Freq\. \(MHz\):\s*(\d+)/);

      const computeUnits = parseInt(computeUnitsMatch?.[1] || "0", 10);
      const maxClockMHz = parseInt(maxClockMatch?.[1] || "0", 10);
      const gfxVersion = gfxVersionMatch?.[1]?.trim() || "unknown";

      // rocminfo often reports generic names like "AMD Radeon Graphics"
      // When detected, use our computed marketing name instead
      const rocminfoMarketingName = marketingNameMatch?.[1]?.trim();
      const isGenericMarketingName =
        !rocminfoMarketingName ||
        rocminfoMarketingName === "AMD Radeon Graphics" ||
        rocminfoMarketingName === "AMD GPU";

      gpus.push({
        index: gpuIndex++,
        name: nameMatch?.[1]?.trim() || "Unknown GPU",
        marketingName: isGenericMarketingName
          ? getMarketingName(gfxVersion, { computeUnits, maxClockMHz })
          : rocminfoMarketingName,
        vendor: vendorMatch?.[1]?.trim() || "AMD",
        deviceType: "GPU",
        gfxVersion,
        computeUnits,
        maxClockMHz,
      });
    }
  }

  return gpus;
}

/**
 * Parse comprehensive GPU info from rocm-smi -a output
 */
function parseRocmSmiAll(output: string): Map<number, Partial<ROCmGPUInfo>> {
  const gpuInfoMap = new Map<number, Partial<ROCmGPUInfo>>();

  // Split output by GPU sections
  const lines = output.split('\n');
  let currentGpuIndex: number | null = null;

  for (const line of lines) {
    // Check for GPU index
    const gpuMatch = line.match(/GPU\[(\d+)\]/);
    if (gpuMatch) {
      currentGpuIndex = parseInt(gpuMatch[1], 10);
      if (!gpuInfoMap.has(currentGpuIndex)) {
        gpuInfoMap.set(currentGpuIndex, { index: currentGpuIndex });
      }
    }

    if (currentGpuIndex === null) continue;

    const currentInfo = gpuInfoMap.get(currentGpuIndex) || {};

    // Device ID
    const deviceIdMatch = line.match(/Device ID:\s*(0x[0-9a-fA-F]+)/);
    if (deviceIdMatch) {
      currentInfo.deviceId = deviceIdMatch[1];
    }

    // GFX Version from rocm-smi (most accurate - reports actual gfx like "gfx1150")
    // Format: "GPU[0] : GFX Version: gfx1150"
    const gfxVersionMatch = line.match(/GFX Version:\s*(gfx\d+[a-z]*)/);
    if (gfxVersionMatch) {
      currentInfo.gfxVersion = gfxVersionMatch[1];
    }

    // Device Revision
    const deviceRevMatch = line.match(/Device Rev:\s*(0x[0-9a-fA-F]+)/);
    if (deviceRevMatch) {
      currentInfo.deviceRev = deviceRevMatch[1];
    }

    // Subsystem ID
    const subsysIdMatch = line.match(/Subsystem ID:\s*(-?0x[0-9a-fA-F]+)/);
    if (subsysIdMatch) {
      currentInfo.subsystemId = subsysIdMatch[1];
    }

    // GUID
    const guidMatch = line.match(/GUID:\s*(\d+)/);
    if (guidMatch) {
      currentInfo.guid = guidMatch[1];
    }

    // VBIOS version
    const vbiosMatch = line.match(/VBIOS version:\s*(.+)/);
    if (vbiosMatch) {
      currentInfo.vbiosVersion = vbiosMatch[1].trim();
    }

    // PCI Bus
    const pciMatch = line.match(/PCI Bus:\s*(.+)/);
    if (pciMatch) {
      currentInfo.pciBus = pciMatch[1].trim();
    }

    // Current clock frequency (from sclk clock level line)
    // Output format: "sclk clock level: 1: (942Mhz)" - note capital H
    const clockMatch = line.match(/sclk clock level:\s*\d+:\s*\((\d+)Mhz\)/i);
    if (clockMatch) {
      currentInfo.currentClockMHz = parseInt(clockMatch[1], 10);
    }

    // Max clock frequency - find the highest supported sclk frequency (marked with *)
    // Format: "0: 600Mhz" / "1: 2900Mhz *" (asterisk = current max)
    const maxClockMatch = line.match(/^\s*(\d+):\s*(\d+)Mhz\s*\*\s*$/i);
    if (maxClockMatch) {
      currentInfo.maxClockMHz = parseInt(maxClockMatch[2], 10);
    }

    // Temperature (from rocm-smi -a)
    // Format: "GPU[0]: Temperature (Sensor edge) (C): 38.0"
    const tempMatch = line.match(/Temperature \(Sensor edge\) \(C\):\s*([\d.]+)/);
    if (tempMatch) {
      currentInfo.temperature = Math.round(parseFloat(tempMatch[1]));
    }

    gpuInfoMap.set(currentGpuIndex, currentInfo);
  }

  return gpuInfoMap;
}

/**
 * Get driver version from rocm-smi
 */
function parseDriverVersion(output: string): string {
  const match = output.match(/Driver version:\s*(.+)/);
  return match?.[1]?.trim() || "unknown";
}

/**
 * Get GPU usage from rocm-smi
 */
async function getGpuUsage(rocmSmiPath: string): Promise<
  Map<
    number,
    {
      usage?: number;
      temperature?: number;
      power?: number;
      memoryUsed?: number;
      memoryTotal?: number;
    }
  >
> {
  const usageMap = new Map<
    number,
    {
      usage?: number;
      temperature?: number;
      power?: number;
      memoryUsed?: number;
      memoryTotal?: number;
    }
  >();

  try {
    // Get GPU usage percentage
    const { stdout: useOutput } = await execAsync(
      `${rocmSmiPath} --showuse 2>/dev/null`
    );
    const useMatches = useOutput.matchAll(
      /GPU\[(\d+)\][\s\S]*?GPU use \(%\):\s*(\d+)/g
    );
    for (const match of useMatches) {
      const index = parseInt(match[1], 10);
      const usage = parseInt(match[2], 10);
      const current = usageMap.get(index) ?? {};
      usageMap.set(index, { ...current, usage });
    }
  } catch {
    // Ignore errors - rocm-smi might not support all flags
  }

  try {
    // Get temperature (-t is the short form; --showtemperature is not supported on all versions)
    const { stdout: tempOutput } = await execAsync(
      `${rocmSmiPath} -t 2>/dev/null`
    );
    const tempMatches = tempOutput.matchAll(
      /GPU\[(\d+)\][\s\S]*?Temperature \(Sensor edge\) \(C\):\s*([\d.]+)/g
    );
    for (const match of tempMatches) {
      const index = parseInt(match[1], 10);
      const temperature = Math.round(parseFloat(match[2]));
      const current = usageMap.get(index) ?? {};
      usageMap.set(index, { ...current, temperature });
    }
  } catch {
    // Ignore errors
  }

  try {
    // Get power consumption
    const { stdout: powerOutput } = await execAsync(
      `${rocmSmiPath} --showpower 2>/dev/null`
    );
    const powerMatches = powerOutput.matchAll(
      /GPU\[(\d+)\][\s\S]*?Current Socket Graphics Package Power \(W\):\s*([\d.]+)/g
    );
    for (const match of powerMatches) {
      const index = parseInt(match[1], 10);
      const power = parseFloat(match[2]);
      const current = usageMap.get(index) ?? {};
      usageMap.set(index, { ...current, power });
    }
  } catch {
    // Ignore errors
  }

  try {
    // Get VRAM usage - use --showmeminfo vram instead of --showvram
    const { stdout: vramOutput } = await execAsync(
      `${rocmSmiPath} --showmeminfo vram 2>/dev/null`
    );
    // Parse: GPU[0] : VRAM Total Memory (B): 34359738368
    //         GPU[0] : VRAM Total Used Memory (B): 912105472
    const vramTotalMatches = vramOutput.matchAll(
      /GPU\[(\d+)\][\s\S]*?VRAM Total Memory \(B\):\s*(\d+)/g
    );
    const vramUsedMatches = vramOutput.matchAll(
      /GPU\[(\d+)\][\s\S]*?VRAM Total Used Memory \(B\):\s*(\d+)/g
    );

    for (const match of vramTotalMatches) {
      const index = parseInt(match[1], 10);
      const totalBytes = parseInt(match[2], 10);
      const current = usageMap.get(index) ?? {};
      usageMap.set(index, {
        ...current,
        memoryTotal: Math.round(totalBytes / (1024 * 1024 * 1024) * 100) / 100,
      });
    }

    for (const match of vramUsedMatches) {
      const index = parseInt(match[1], 10);
      const usedBytes = parseInt(match[2], 10);
      const current = usageMap.get(index) ?? {};
      usageMap.set(index, {
        ...current,
        memoryUsed: Math.round(usedBytes / (1024 * 1024 * 1024) * 100) / 100,
      });
    }
  } catch {
    // Ignore errors
  }

  return usageMap;
}

/**
 * Get comprehensive GPU info from rocm-smi -a
 */
async function getComprehensiveGpuInfo(rocmSmiPath: string): Promise<{
  driverVersion: string;
  gpuInfo: Map<number, Partial<ROCmGPUInfo>>;
}> {
  try {
    const { stdout } = await execAsync(`${rocmSmiPath} -a 2>&1`);
    const driverVersion = parseDriverVersion(stdout);
    const gpuInfo = parseRocmSmiAll(stdout);
    return { driverVersion, gpuInfo };
  } catch (error) {
    console.error("Failed to get comprehensive GPU info:", error);
    return { driverVersion: "unknown", gpuInfo: new Map() };
  }
}

/**
 * Get ROCm runtime version
 * Prefers /opt/rocm/.info/version-rocm (e.g. "7.2.1-81") which reflects the actual
 * ROCm stack version. Falls back to rocminfo parsing which reports the GFX
 * runtime version (e.g. "1.18" for gfx1151) rather than the ROCm release version.
 */
async function getRocmVersion(rocmInfoPath: string): Promise<string> {
  // Try the ROCm version file first - this is the actual ROCm release version
  const versionFilePaths = [
    "/opt/rocm/.info/version-rocm",
    "/opt/rocm/.info/version",
  ];

  // Newer ROCm layouts install under /opt/rocm/core-<version>/ with symlinks at top level
  // Search for .info/version under any /opt/rocm/core-* directory
  try {
    const { stdout } = await execAsync("ls -d /opt/rocm/core-*/.info/version 2>/dev/null");
    const extraPaths = stdout.trim().split("\n").filter(Boolean);
    versionFilePaths.push(...extraPaths);
  } catch {
    // No core-* directories found
  }

  for (const versionFile of versionFilePaths) {
    try {
      const { stdout } = await execAsync(`cat ${versionFile} 2>/dev/null`);
      const trimmed = stdout.trim();
      // version files are in format "7.2.1-81" - strip the package suffix
      const match = trimmed.match(/^(\d+\.\d+\.\d+)/);
      if (match) {
        return match[1];
      }
      if (trimmed) {
        return trimmed;
      }
    } catch {
      // Continue to next file
    }
  }

  // Fallback: parse rocminfo output (less reliable - gives GFX runtime version)
  try {
    const { stdout } = await execAsync(`${rocmInfoPath} 2>&1`);
    const versionMatch = stdout.match(/Runtime Version:\s*([\d.]+)/);
    return versionMatch?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Detect ROCm installation and get GPU information
 */
export async function detectROCm(): Promise<ROCmSystemInfo> {
  const rocmInfoPath = await findRocmInfo();
  const rocmSmiPath = await findRocmSmi();

  if (!rocmInfoPath) {
    return {
      detected: false,
      runtimeVersion: "",
      gpus: [],
    };
  }

  try {
    const { stdout } = await execAsync(`${rocmInfoPath} 2>&1`);
    const gpus = parseRocmInfo(stdout);
    const runtimeVersion = await getRocmVersion(rocmInfoPath);

    // Get comprehensive info from rocm-smi -a
    let driverVersion = "unknown";
    let comprehensiveInfo = new Map<number, Partial<ROCmGPUInfo>>();

    if (rocmSmiPath) {
      const comprehensive = await getComprehensiveGpuInfo(rocmSmiPath);
      driverVersion = comprehensive.driverVersion;
      comprehensiveInfo = comprehensive.gpuInfo;

      // Also get real-time metrics
      const usageData = await getGpuUsage(rocmSmiPath);

      for (const gpu of gpus) {
        // Merge comprehensive info using intelligent matching
        const extraInfo = matchGpuWithSmiData(gpu, comprehensiveInfo);
        if (extraInfo) {
          gpu.deviceId = extraInfo.deviceId;
          gpu.deviceRev = extraInfo.deviceRev;
          gpu.subsystemId = extraInfo.subsystemId;
          gpu.guid = extraInfo.guid;
          gpu.vbiosVersion = extraInfo.vbiosVersion;
          gpu.pciBus = extraInfo.pciBus;
          gpu.currentClockMHz = extraInfo.currentClockMHz;
          // Override gfxVersion with rocm-smi's IP version if available (most accurate)
          // Otherwise fall back to device-ID-resolved value
          if (extraInfo.gfxVersion) {
            gpu.gfxVersion = extraInfo.gfxVersion;
          } else {
            gpu.gfxVersion = resolveGfxVersion(gpu.deviceId, gpu.gfxVersion ?? "");
          }
          gpu.marketingName = getMarketingName(gpu.gfxVersion, {
            computeUnits: gpu.computeUnits,
            maxClockMHz: gpu.maxClockMHz,
            deviceId: gpu.deviceId
          });
          // Override maxClockMHz with the actual supported max from rocm-smi
          if (extraInfo.maxClockMHz !== undefined) {
            gpu.maxClockMHz = extraInfo.maxClockMHz;
          }
          // Temperature from rocm-smi -a (more reliable than --showtemperature)
          if (extraInfo.temperature !== undefined) {
            gpu.temperature = extraInfo.temperature;
          }
        }

        // Set driver version on each GPU
        gpu.driverVersion = driverVersion;

        // Merge real-time metrics using index-based lookup (rocm-smi --showuse matches rocm-smi -a indices)
        // Only override values that are actually present in metrics — some rocm-smi
        // flags (e.g., --showtemperature) may fail on certain versions, leaving fields
        // as undefined. We must not overwrite a valid value from rocm-smi -a with undefined.
        const metrics = usageData.get(extraInfo?.index ?? gpu.index);
        if (metrics) {
          if (metrics.usage !== undefined) gpu.usage = metrics.usage;
          if (metrics.temperature !== undefined) gpu.temperature = metrics.temperature;
          if (metrics.power !== undefined) gpu.power = metrics.power;
          if (metrics.memoryTotal !== undefined) {
            gpu.memory = {
              total: metrics.memoryTotal,
              used: metrics.memoryUsed || 0,
            };
          }
        }
      }
    } else {
      // rocm-smi not available — fall back to sysfs for real-time metrics
      // This preserves static rocminfo data (name, gfxVersion, computeUnits)
      // while adding temperature, usage, memory, clock, and power from DRM sysfs
      for (let i = 0; i < gpus.length; i++) {
        const gpu = gpus[i];
        // Resolve gfxVersion from deviceId if available
        if (gpu.deviceId) {
          gpu.gfxVersion = resolveGfxVersion(gpu.deviceId, gpu.gfxVersion ?? "");
        }
        gpu.marketingName = getMarketingName(gpu.gfxVersion, {
          computeUnits: gpu.computeUnits,
          maxClockMHz: gpu.maxClockMHz,
          deviceId: gpu.deviceId,
        });
        // Attempt sysfs fallback enrichment (pass index for DRM card ordering fallback)
        await enrichWithSysfsFallback(gpu, i);
      }
    }

    return {
      detected: true,
      runtimeVersion,
      gpus,
      rocmInfoPath,
      rocmSmiPath,
    };
  } catch (error) {
    console.error("Failed to detect ROCm:", error);
    return {
      detected: false,
      runtimeVersion: "",
      gpus: [],
    };
  }
}

