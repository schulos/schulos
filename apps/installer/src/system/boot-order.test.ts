import { describe, expect, it } from "vitest";
import { BOOT_LOADER, newBootOrder, parseEfibootmgr, setBootOrder, type RunSync } from "./boot-order";

// efibootmgr 17 (Tab) bzw. 18 (zwei Leerzeichen), Hyper-V Gen2 mit eingelegter ISO
const HYPERV = [
  "BootCurrent: 0001",
  "Timeout: 0 seconds",
  "BootOrder: 0001,0000,0002",
  "Boot0000* EFI SCSI Device\tPciRoot(0x0)/Pci(0x7,0x0)",
  "Boot0001* EFI SCSI Device 1  PciRoot(0x0)/Pci(0x7,0x0)/Scsi(0,1)",
  "Boot0002* EFI Network\tMAC(00155d000000,0)",
  "",
].join("\n");

describe("UEFI-Startreihenfolge (INST-01)", () => {
  it("liest BootOrder und Einträge", () => {
    const p = parseEfibootmgr(HYPERV);
    expect(p.order).toEqual(["0001", "0000", "0002"]);
    expect(p.entries).toEqual([
      { num: "0000", label: "EFI SCSI Device" },
      { num: "0001", label: "EFI SCSI Device 1" },
      { num: "0002", label: "EFI Network" },
    ]);
  });

  it("neue Reihenfolge: eigene Einträge vorn, Rest ohne Doppelte", () => {
    expect(newBootOrder(["0001", "0000", "0003", "0002"], ["0003"])).toEqual(["0003", "0001", "0000", "0002"]);
    expect(newBootOrder(["0001", "0004", "0003"], ["0003", "0004"])).toEqual(["0003", "0004", "0001"]);
  });

  /** efibootmgr im Speicher nachgebaut */
  function fakeEfi(entries: { num: string; label: string }[], order: string[], o: { failCreate?: boolean } = {}) {
    const calls: string[][] = [];
    const run: RunSync = (argv) => {
      calls.push(argv);
      const a = argv.slice(1);
      if (a.includes("--delete-bootnum")) {
        const n = a[a.indexOf("--bootnum") + 1]!;
        entries = entries.filter((e) => e.num !== n);
        order = order.filter((x) => x !== n);
      } else if (a.includes("--create")) {
        if (o.failCreate) return { code: 1, stdout: "", stderr: "Could not prepare Boot variable: Read-only file system" };
        const num = (Math.max(0, ...entries.map((e) => parseInt(e.num, 16))) + 1).toString(16).toUpperCase().padStart(4, "0");
        entries.push({ num, label: a[a.indexOf("--label") + 1]! });
        order = [num, ...order];
      } else if (a.includes("--bootorder")) order = a[a.indexOf("--bootorder") + 1]!.split(",");
      const out = [`BootOrder: ${order.join(",")}`, ...entries.map((e) => `Boot${e.num}* ${e.label}\tHD(1,GPT)`)].join("\n");
      return { code: 0, stdout: out, stderr: "" };
    };
    return { run, calls };
  }

  it("eine Platte: alter SchulOS-Eintrag weg, neuer vorn, Loader = shim auf dem Fallback-Pfad", () => {
    const f = fakeEfi(
      [
        { num: "0000", label: "EFI SCSI Device" },
        { num: "0005", label: "SchulOS" },
      ],
      ["0000", "0005"],
    );
    const r = setBootOrder({ disks: ["/dev/sda"] }, f.run);
    expect(r).toEqual({ ok: true, order: ["0001", "0000"] });
    expect(f.calls).toContainEqual(["efibootmgr", "--quiet", "--bootnum", "0005", "--delete-bootnum"]);
    expect(f.calls).toContainEqual(["efibootmgr", "--quiet", "--create", "--disk", "/dev/sda", "--part", "1", "--label", "SchulOS", "--loader", BOOT_LOADER]);
    expect(BOOT_LOADER).toBe("\\EFI\\BOOT\\BOOTX64.EFI");
  });

  it("Spiegel: beide Platten vorn, Platte 1 zuerst", () => {
    const f = fakeEfi([{ num: "0001", label: "UEFI DVD" }], ["0001"]);
    const r = setBootOrder({ disks: ["/dev/nvme0n1", "/dev/nvme1n1"] }, f.run);
    expect(r).toEqual({ ok: true, order: ["0002", "0003", "0001"] });
    expect(f.calls.find((c) => c.includes("/dev/nvme1n1"))).toContain("SchulOS (Platte 2)");
  });

  it("fremde Einträge mit ähnlichem Namen bleiben", () => {
    const f = fakeEfi([{ num: "0001", label: "SchulOS Test-Stick" }], ["0001"]);
    setBootOrder({ disks: ["/dev/sda"] }, f.run);
    expect(f.calls.some((c) => c.includes("--delete-bootnum"))).toBe(false);
  });

  it("ohne EFI-Variablen bzw. gesperrtes NVRAM: Fehler mit Grund statt Neustart ins Medium", () => {
    expect(setBootOrder({ disks: ["/dev/sda"] }, () => ({ code: 2, stdout: "", stderr: "EFI variables are not supported on this system." }))).toEqual({
      ok: false,
      reason: "EFI variables are not supported on this system.",
    });
    const f = fakeEfi([], [], { failCreate: true });
    expect(setBootOrder({ disks: ["/dev/sda"] }, f.run)).toMatchObject({ ok: false, reason: expect.stringContaining("Read-only") });
  });
});
