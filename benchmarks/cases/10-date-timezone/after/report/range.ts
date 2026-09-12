export function dayRange(isoDate: string): [Date, Date] {
  const [y, m, d] = isoDate.split("-").map(Number);
  const start = new Date(y, m, d);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}
