// Beispielantworten und Rechner für die Installer-Tests.
import type { Answers, InstallContext } from "./questions";

export const GB = 1024 ** 3;
export const CTX: InstallContext = {
  tpm2: true,
  disks: [
    { path: "/dev/sda", sizeBytes: 500 * GB, model: "Samsung SSD 870" },
    { path: "/dev/sdb", sizeBytes: 480 * GB, model: "Crucial MX500" },
    { path: "/dev/sdc", sizeBytes: 8 * GB, model: "USB-Stick" },
  ],
};

export const PRODUCTION: Answers = {
  role: "main",
  instance: "production",
  "disk.devices": ["/dev/sda"],
  "access.password": "Wartung-im-Keller-2026",
  "school.name": "Gesamtschule Musterstadt",
  "school.number": "123456",
  "admin.first_name": "Ina",
  "admin.last_name": "Tech",
  "admin.username": "ina.tech",
  "admin.password": "Lange-Leitung-Kaffee-42",
  "web.domain": "schulos.gs-musterstadt.de",
  "backup.url": "https://backup.gs-musterstadt.de",
  "backup.code": "k7q2 9mxa 4rt1",
};

export const BACKUP: Answers = {
  role: "backup",
  "disk.devices": ["/dev/sda", "/dev/sdb"],
  "access.password": "Wartung-im-Keller-2026",
  "admin.first_name": "Ina",
  "admin.last_name": "Tech",
  "admin.username": "ina.tech",
  "admin.password": "Lange-Leitung-Kaffee-42",
  "web.domain": "backup.gs-musterstadt.de",
};
