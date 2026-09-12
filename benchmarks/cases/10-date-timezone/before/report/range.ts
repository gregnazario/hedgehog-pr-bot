export function dayRange(isoDate: string): [Date, Date] {
  const start = new Date(`${isoDate}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return [start, end];
}
