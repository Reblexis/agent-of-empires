export interface PlannerTask {
  id: string;
  number: number;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  priority: number | null;
  status: "open" | "missed" | "done";
  isTemplate?: boolean;
}

export interface PlannerSnapshot {
  tasks: PlannerTask[];
  timeZone: string;
  fetchedAt: string;
  truncated: boolean;
}

/** Compare wall-clock strings in the planner's zone, including DST repeated hours. */
export function wallNow(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

// telarchy-tasks docs/tasks.md: precision is the interval, start is its beginning,
// due is its end. No timezone conversion of a partial date into an appointment.
function bound(point: string | null, end: boolean): string | null {
  if (!point) return null;
  const [date, time] = point.split("T");
  const [year, month = end ? "12" : "01", day] = date!.split("-");
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const [hour = end ? "23" : "00", minute = end ? "59" : "00", second = end ? "59" : "00"] = (time ?? "").split(":");
  return `${year}-${month}-${day ?? (end ? String(lastDay) : "01")}T${hour || (end ? "23" : "00")}:${minute}:${second}`;
}

export function validPlannerSnapshot(value: PlannerSnapshot): boolean {
  try {
    wallNow(new Date(), value.timeZone);
    if (!Number.isFinite(Date.parse(value.fetchedAt)) || typeof value.truncated !== "boolean") return false;
    return (
      Array.isArray(value.tasks) &&
      value.tasks.every((t) => {
        const validPoint = (p: unknown) => {
          if (p == null) return true;
          if (typeof p !== "string" || !/^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2})?)?)?)?)?$/.test(p)) return false;
          const lo = bound(p, false)!;
          const parsed = new Date(`${lo}Z`);
          return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === lo;
        };
        return (
          typeof t.id === "string" &&
          typeof t.title === "string" &&
          t.title.length > 0 &&
          Number.isInteger(t.number) &&
          t.number > 0 &&
          ["open", "missed", "done"].includes(t.status) &&
          validPoint(t.startDate) &&
          validPoint(t.dueDate) &&
          (!t.startDate || !t.dueDate || bound(t.startDate, false)! <= bound(t.dueDate, true)!)
        );
      })
    );
  } catch {
    return false;
  }
}

export function plannerGroups(tasks: PlannerTask[], now: string) {
  const groups: Record<"now" | "upcoming" | "flexible" | "overdue", PlannerTask[]> = {
    now: [],
    upcoming: [],
    flexible: [],
    overdue: [],
  };
  for (const task of tasks) {
    if (task.status === "done" || task.isTemplate) continue;
    const start = bound(task.startDate, false);
    const due = bound(task.dueDate, true);
    if (due && due < now) groups.overdue.push(task);
    else if (!task.startDate?.includes("T") && !task.dueDate?.includes("T")) groups.flexible.push(task);
    else if (start && start > now) groups.upcoming.push(task);
    else groups.now.push(task);
  }
  const priority = (a: PlannerTask, b: PlannerTask) => (b.priority ?? 0) - (a.priority ?? 0);
  const deadline = (t: PlannerTask) => bound(t.dueDate, true) ?? bound(t.startDate, false) ?? "9999";
  groups.now.sort((a, b) => priority(a, b) || deadline(a).localeCompare(deadline(b)));
  groups.upcoming.sort(
    (a, b) => bound(a.startDate, false)!.localeCompare(bound(b.startDate, false)!) || priority(a, b),
  );
  groups.flexible.sort((a, b) => deadline(a).localeCompare(deadline(b)) || priority(a, b));
  groups.overdue.sort((a, b) => deadline(a).localeCompare(deadline(b)));
  return groups;
}

export function plannerWindow(task: PlannerTask): string {
  const format = (point: string) => point.replace("T", " ");
  if (!task.startDate && !task.dueDate) return "Anytime";
  if (!task.startDate) return `By ${format(task.dueDate!)}`;
  if (!task.dueDate) return `From ${format(task.startDate)}`;
  if (task.startDate === task.dueDate) return format(task.startDate);
  const due =
    task.startDate.slice(0, 10) === task.dueDate.slice(0, 10) && task.dueDate.includes("T")
      ? task.dueDate.split("T")[1]!
      : format(task.dueDate);
  return `${format(task.startDate)} to ${due}`;
}
