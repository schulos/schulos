const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

/** Bytes lesbar (1 024er-Stufen, deutsche Zahl): „1,5 GB“. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${nf.format(v)} ${units[u]}`;
}
