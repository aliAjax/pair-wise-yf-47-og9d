import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已收束";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "排队中" | "待确认" | "已确认" | "已执行" | "已结束";

// 车站对外状态严重度：取未收束事件里最严重的一条
export const STATUS_SEVERITY: Record<StationStatus, number> = { 正常: 0, 恢复中: 1, 限流: 2, 封闭: 3 };
export const STATION_REPORTERS: Role[] = ["调度员", "车站值班员"];
export const PLAN_OPERATORS: Role[] = ["调度员", "公交接驳负责人"];
export const PLAN_APPROVERS: Role[] = ["调度员", "公交接驳负责人"];

const ACTIVE_PLAN_STATUSES: PlanStatus[] = ["待确认", "已确认", "已执行"];
const STORAGE_KEY = "pair-wise-yf-47/ledger";
const POOL_SIZE = 12;

export interface Incident {
  id: string;
  title: string;
  section: string;
  status: IncidentStatus;
  startedAt: string;
  closedAt?: string;
}

export interface Station {
  id: string;
  name: string;
  section: string;
  passengerRisk: "低" | "中" | "高";
}

/** 事件对车站的状态上报：按（事件, 车站）记账，互不覆盖 */
export interface StationReport {
  id: string;
  incidentId: string;
  stationId: string;
  status: StationStatus;
  note: string;
  actor: Role;
  time: string;
}

/** 车站对外视图：由未收束事件的上报推导，不直接落库 */
export interface StationView extends Station {
  status: StationStatus;
  note: string;
  updatedAt: string;
  sourceIncidentId?: string;
  sourceIncidentTitle?: string;
}

export interface ShuttlePlan {
  id: string;
  incidentId: string;
  stations: string[];
  vehicles: number;
  vehicleIds: string[];
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Role[];
  note: string;
  createdAt: string;
}

export interface Statement {
  id: string;
  content: string;
  author: Role;
  time: string;
  valid: boolean;
  invalidReason?: string;
}

export interface VehicleConflict {
  id: string;
  vehicleId: string;
  planIds: string[];
  detail: string;
  time: string;
  resolved: boolean;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复" | "同步";
}

export interface PendingAction {
  id: string;
  kind: "新建事件" | "上报车站状态" | "收束事件" | "更新接驳计划" | "发布对外口径" | "处置记录";
  time: string;
  detail: string;
  incidentId?: string;
  incident?: Incident;
  report?: StationReport;
  plan?: ShuttlePlan;
  statement?: Statement;
  entry?: TimelineEntry;
}

interface LedgerData {
  incidents: Incident[];
  stations: Station[];
  reports: StationReport[];
  plans: ShuttlePlan[];
  statements: Statement[];
  conflicts: VehicleConflict[];
  timeline: TimelineEntry[];
  poolSize: number;
}

interface IncidentStore extends LedgerData {
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  addIncident: (title: string, section: string) => string | null;
  closeIncident: (id: string) => string | null;
  reportStationStatus: (incidentId: string, stationId: string, status: StationStatus, note: string) => string | null;
  addPlan: (plan: { incidentId: string; stations: string[]; vehicles: number; interval: number; operator: string; note: string }) => string | null;
  submitPlan: (id: string) => string | null;
  updatePlanVehicles: (id: string, vehicles: number) => string | null;
  approvePlan: (id: string) => string | null;
  executePlan: (id: string) => string | null;
  publishStatement: (content: string) => string | null;
  addTimeline: (action: string, detail: string, phase: TimelineEntry["phase"]) => void;
  syncActions: () => void;
}

const now = () => new Date().toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const uid = () => crypto.randomUUID();
export const shortId = (id: string) => id.slice(0, 6);

// ---------- 车辆池 ----------

export const poolVehicleIds = (poolSize: number) => Array.from({ length: poolSize }, (_, i) => `V-${String(i + 1).padStart(2, "0")}`);

export const allocatedVehicleIds = (plans: ShuttlePlan[]) =>
  new Set(plans.filter((p) => ACTIVE_PLAN_STATUSES.includes(p.status)).flatMap((p) => p.vehicleIds));

function tryAllocate(plans: ShuttlePlan[], poolSize: number, count: number): string[] | null {
  const used = allocatedVehicleIds(plans);
  const free = poolVehicleIds(poolSize).filter((v) => !used.has(v));
  return free.length >= count ? free.slice(0, count) : null;
}

/** 容量释放后，排队中的计划按创建顺序补位 */
function retryQueuedPlans(plans: ShuttlePlan[], poolSize: number): { plans: ShuttlePlan[]; promoted: ShuttlePlan[] } {
  const result = [...plans];
  const promoted: ShuttlePlan[] = [];
  const queued = result
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) => plan.status === "排队中")
    .sort((a, b) => a.plan.createdAt.localeCompare(b.plan.createdAt));
  for (const { plan, index } of queued) {
    const alloc = tryAllocate(result, poolSize, plan.vehicles);
    if (alloc) {
      result[index] = { ...plan, status: "待确认", vehicleIds: alloc };
      promoted.push(result[index]);
    }
  }
  return { plans: result, promoted };
}

/** 同一辆车被两条生效中的计划同时占用 → 冲突 */
export function findVehicleConflicts(plans: ShuttlePlan[]): { vehicleId: string; planIds: string[] }[] {
  const holders = new Map<string, string[]>();
  for (const plan of plans) {
    if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) continue;
    for (const vehicleId of plan.vehicleIds) holders.set(vehicleId, [...(holders.get(vehicleId) ?? []), plan.id]);
  }
  return [...holders.entries()]
    .filter(([, planIds]) => planIds.length > 1)
    .map(([vehicleId, planIds]) => ({ vehicleId, planIds }));
}

/** 扫描计划占用：新出现的重复占用留下冲突记录，已不复存在的占用标记解除 */
function reconcileConflicts(existing: VehicleConflict[], plans: ShuttlePlan[]): VehicleConflict[] {
  const keyOf = (vehicleId: string, planIds: string[]) => `${vehicleId}|${[...planIds].sort().join("+")}`;
  const detected = findVehicleConflicts(plans);
  const detectedKeys = new Set(detected.map((c) => keyOf(c.vehicleId, c.planIds)));
  const kept = existing.map((c) => (!c.resolved && !detectedKeys.has(keyOf(c.vehicleId, c.planIds)) ? { ...c, resolved: true } : c));
  const fresh = detected
    .filter((c) => !kept.some((k) => !k.resolved && keyOf(k.vehicleId, k.planIds) === keyOf(c.vehicleId, c.planIds)))
    .map((c) => ({
      id: uid(),
      vehicleId: c.vehicleId,
      planIds: c.planIds,
      time: now(),
      resolved: false,
      detail: `车辆 ${c.vehicleId} 被 ${c.planIds.length} 条计划同时占用`
    }));
  return [...fresh, ...kept];
}

// ---------- 车站对外状态推导 ----------

export function deriveStationViews(stations: Station[], incidents: Incident[], reports: StationReport[]): StationView[] {
  const openIncidentIds = new Set(incidents.filter((i) => i.status !== "已收束").map((i) => i.id));
  return stations.map((station) => {
    const relevant = reports
      .filter((r) => r.stationId === station.id && openIncidentIds.has(r.incidentId))
      .sort((a, b) => b.time.localeCompare(a.time));
    // 每条未收束事件取它对该站的最新一条上报
    const latestByIncident = new Map<string, StationReport>();
    for (const report of relevant) {
      if (!latestByIncident.has(report.incidentId)) latestByIncident.set(report.incidentId, report);
    }
    let worst: StationReport | undefined;
    for (const report of latestByIncident.values()) {
      if (!worst || STATUS_SEVERITY[report.status] > STATUS_SEVERITY[worst.status]) worst = report;
    }
    const source = worst ? incidents.find((i) => i.id === worst!.incidentId) : undefined;
    return {
      ...station,
      status: worst?.status ?? "正常",
      note: worst?.note ?? "—",
      updatedAt: worst?.time ?? "",
      sourceIncidentId: source?.id,
      sourceIncidentTitle: source?.title
    };
  });
}

// ---------- 对外口径 ----------

function invalidateStatements(statements: Statement[], reason: string): Statement[] {
  return statements.map((s) => (s.valid ? { ...s, valid: false, invalidReason: reason } : s));
}

// ---------- 落账动作（在线操作与离线合并共用） ----------

function applyReport(data: LedgerData, report: StationReport, entry: TimelineEntry, stationName: string): LedgerData {
  return {
    ...data,
    reports: [report, ...data.reports],
    timeline: [entry, ...data.timeline],
    statements: invalidateStatements(data.statements, `车站状态变动：${stationName} → ${report.status}`)
  };
}

function applyCloseIncident(data: LedgerData, incidentId: string, closedAt: string, entry: TimelineEntry): LedgerData {
  const incident = data.incidents.find((i) => i.id === incidentId);
  const incidents = data.incidents.map((i) => (i.id === incidentId ? { ...i, status: "已收束" as const, closedAt } : i));
  // 事件收束：其接驳计划结束、车辆回池，排队计划补位
  let plans = data.plans.map((p) =>
    p.incidentId === incidentId && (ACTIVE_PLAN_STATUSES.includes(p.status) || p.status === "排队中")
      ? { ...p, status: "已结束" as const, vehicleIds: [] }
      : p
  );
  const retried = retryQueuedPlans(plans, data.poolSize);
  plans = retried.plans;
  const finalEntry = retried.promoted.length ? { ...entry, detail: `${entry.detail}，${retried.promoted.length} 条排队计划补位` } : entry;
  return {
    ...data,
    incidents,
    plans,
    timeline: [finalEntry, ...data.timeline],
    statements: invalidateStatements(data.statements, `事件收束：${incident?.title ?? incidentId}，车站对外状态已重算`),
    conflicts: reconcileConflicts(data.conflicts, plans)
  };
}

// ---------- 离线队列合并 ----------

/** 网络恢复后把本地队列合并进服务端快照：上报按（事件, 车站）去重留最新，车辆重复占用留下冲突 */
function mergePendingActions(server: LedgerData, queue: PendingAction[]): LedgerData {
  let data: LedgerData = { ...server };

  // 按事件+车站合并：同一事件对同一车站的多条上报只保留最新一条（队列有序，同刻取后者）
  const latestReports = new Map<string, StationReport>();
  for (const action of queue) {
    if (!action.report) continue;
    const key = `${action.report.incidentId}:${action.report.stationId}`;
    const prev = latestReports.get(key);
    if (!prev || prev.time <= action.report.time) latestReports.set(key, action.report);
  }
  // 同一计划的多条离线变更只保留最终快照
  const latestPlans = new Map<string, ShuttlePlan>();
  for (const action of queue) {
    if (action.plan) latestPlans.set(action.plan.id, action.plan);
  }
  const collapsed = queue
    .filter((action) => {
      if (action.report) return latestReports.get(`${action.report.incidentId}:${action.report.stationId}`) === action.report;
      if (action.plan) return latestPlans.get(action.plan.id) === action.plan;
      return true;
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  for (const action of collapsed) {
    if (action.kind === "新建事件" && action.incident) {
      if (!data.incidents.some((i) => i.id === action.incident!.id)) data = { ...data, incidents: [action.incident, ...data.incidents] };
      if (action.entry) data = { ...data, timeline: [action.entry, ...data.timeline] };
    } else if (action.kind === "上报车站状态" && action.report) {
      const report = action.report;
      // 服务端已有同一（事件, 车站）更新的上报时，保留服务端较新的一条（同刻以本地队列为准）
      const serverHasNewer = data.reports.some((r) => r.incidentId === report.incidentId && r.stationId === report.stationId && r.time > report.time);
      if (!serverHasNewer) {
        const stationName = data.stations.find((s) => s.id === report.stationId)?.name ?? report.stationId;
        data = applyReport(data, report, action.entry!, stationName);
      }
    } else if (action.kind === "收束事件" && action.incidentId) {
      data = applyCloseIncident(data, action.incidentId, action.time, action.entry!);
    } else if (action.kind === "更新接驳计划" && action.plan) {
      const plan = action.plan;
      const plans = data.plans.some((p) => p.id === plan.id) ? data.plans.map((p) => (p.id === plan.id ? plan : p)) : [plan, ...data.plans];
      data = { ...data, plans, statements: invalidateStatements(data.statements, `接驳车辆数变动：计划 ${shortId(plan.id)}`) };
      if (action.entry) data = { ...data, timeline: [action.entry, ...data.timeline] };
    } else if (action.kind === "发布对外口径" && action.statement) {
      if (!data.statements.some((s) => s.id === action.statement!.id)) data = { ...data, statements: [action.statement, ...data.statements] };
      if (action.entry) data = { ...data, timeline: [action.entry, ...data.timeline] };
    } else if (action.kind === "处置记录" && action.entry) {
      if (!data.timeline.some((t) => t.id === action.entry!.id)) data = { ...data, timeline: [action.entry, ...data.timeline] };
    }
  }

  // 合并后校验：同一辆车被两条计划同时占用就留下冲突
  data = { ...data, conflicts: reconcileConflicts(data.conflicts, data.plans) };
  data = { ...data, plans: retryQueuedPlans(data.plans, data.poolSize).plans };
  return data;
}

// ---------- 持久化（localStorage 模拟服务端，弱网期间不可写） ----------

const serverStorage: StateStorage = {
  getItem: (name) => (typeof window === "undefined" ? null : window.localStorage.getItem(name)),
  setItem: (name, value) => {
    if (typeof window === "undefined") return;
    try {
      // 弱网期间服务端不可写：操作留在本地队列，恢复在线后合并写回
      if ((JSON.parse(value) as { state?: { online?: boolean } }).state?.online === false) return;
    } catch {
      // 解析失败按可写处理
    }
    window.localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    if (typeof window !== "undefined") window.localStorage.removeItem(name);
  }
};

function readServerSnapshot(): LedgerData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = (JSON.parse(raw) as { state?: Partial<LedgerData> }).state;
    if (!state?.incidents || !state?.plans) return null;
    return {
      incidents: state.incidents,
      stations: state.stations ?? [],
      reports: state.reports ?? [],
      plans: state.plans,
      statements: state.statements ?? [],
      conflicts: state.conflicts ?? [],
      timeline: state.timeline ?? [],
      poolSize: state.poolSize ?? POOL_SIZE
    };
  } catch {
    return null;
  }
}

const pickLedger = (s: LedgerData): LedgerData => ({
  incidents: s.incidents,
  stations: s.stations,
  reports: s.reports,
  plans: s.plans,
  statements: s.statements,
  conflicts: s.conflicts,
  timeline: s.timeline,
  poolSize: s.poolSize
});

// ---------- 种子数据：相邻区段两起事件，会展中心站被同时覆盖 ----------

function seedLedger(): LedgerData {
  return {
    incidents: [
      { id: "INC-20261006-02", title: "会展中心站信号故障", section: "会展中心站—滨江站", status: "处置中", startedAt: minutesAgo(12) },
      { id: "INC-20261006-01", title: "滨江站区间积水停运", section: "中心站—滨江站", status: "处置中", startedAt: minutesAgo(35) }
    ],
    stations: [
      { id: "s1", name: "滨江站", section: "中心站—滨江站", passengerRisk: "高" },
      { id: "s2", name: "会展中心站", section: "会展中心站—滨江站", passengerRisk: "中" },
      { id: "s3", name: "东港站", section: "滨江站—东港站", passengerRisk: "低" }
    ],
    reports: [
      { id: "r3", incidentId: "INC-20261006-02", stationId: "s2", status: "封闭", note: "信号故障，站台清客", actor: "调度员", time: minutesAgo(9) },
      { id: "r2", incidentId: "INC-20261006-01", stationId: "s2", status: "限流", note: "出入口单向组织", actor: "车站值班员", time: minutesAgo(20) },
      { id: "r1", incidentId: "INC-20261006-01", stationId: "s1", status: "封闭", note: "站台积水，已启动公交接驳", actor: "车站值班员", time: minutesAgo(27) }
    ],
    plans: [
      {
        id: "p1",
        incidentId: "INC-20261006-01",
        stations: ["s1", "s2"],
        vehicles: 8,
        vehicleIds: poolVehicleIds(POOL_SIZE).slice(0, 8),
        interval: 6,
        operator: "东城公交",
        status: "待确认",
        approvals: ["调度员"],
        note: "优先疏运站外滞留乘客",
        createdAt: minutesAgo(18)
      }
    ],
    statements: [
      { id: "st1", content: "滨江站公交接驳已开通，请乘客听从现场引导有序换乘。", author: "客服主管", time: minutesAgo(15), valid: true }
    ],
    conflicts: [],
    timeline: [
      { id: "e4", time: minutesAgo(9), actor: "调度员", action: "上报车站状态", detail: "会展中心站 → 封闭（会展中心站信号故障）", phase: "响应" },
      { id: "e3", time: minutesAgo(12), actor: "调度员", action: "启动事件", detail: "会展中心站信号故障，相邻区段接连告警", phase: "发现" },
      { id: "e2", time: minutesAgo(27), actor: "车站值班员", action: "上报车站状态", detail: "滨江站 → 封闭（滨江站区间积水停运）", phase: "响应" },
      { id: "e1", time: minutesAgo(35), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" }
    ],
    poolSize: POOL_SIZE
  };
}

// ---------- Store ----------

export const useIncidentStore = create<IncidentStore>()(
  persist(
    (set, get) => ({
      ...seedLedger(),
      role: "调度员",
      online: true,
      pendingActions: [],

      setRole: (role) => set({ role }),

      setOnline: (online) => {
        // 恢复在线时先把本地队列按事件+车站合并，再上线写回服务端
        if (online) get().syncActions();
        set({ online });
      },

      addIncident: (title, section) => {
        const { role } = get();
        if (role !== "调度员") return `越权操作被拒绝：${role} 无权新建事件`;
        const incident: Incident = { id: `INC-${Date.now().toString(36).toUpperCase()}`, title, section, status: "处置中", startedAt: now() };
        const entry: TimelineEntry = { id: uid(), time: now(), actor: role, action: "启动事件", detail: `${title}（${section}）`, phase: "发现" };
        set((s) => ({
          incidents: [incident, ...s.incidents],
          timeline: [entry, ...s.timeline],
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "新建事件" as const, time: now(), detail: entry.detail, incident, entry }]
        }));
        return null;
      },

      closeIncident: (id) => {
        const { role, incidents, plans } = get();
        if (role !== "调度员") return `越权操作被拒绝：${role} 无权收束事件`;
        const incident = incidents.find((i) => i.id === id);
        if (!incident) return "事件不存在";
        if (incident.status === "已收束") return "事件已收束";
        const affected = plans.filter((p) => p.incidentId === id && (ACTIVE_PLAN_STATUSES.includes(p.status) || p.status === "排队中")).length;
        const entry: TimelineEntry = {
          id: uid(),
          time: now(),
          actor: role,
          action: "收束事件",
          detail: `${incident.title} 收束，${affected} 条接驳计划结束、车辆回池，车站对外状态立即重算`,
          phase: "恢复"
        };
        set((s) => ({
          ...applyCloseIncident(pickLedger(s), id, now(), entry),
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "收束事件" as const, time: now(), detail: entry.detail, incidentId: id, entry }]
        }));
        return null;
      },

      reportStationStatus: (incidentId, stationId, status, note) => {
        const { role, incidents, stations } = get();
        if (!STATION_REPORTERS.includes(role)) return `越权操作被拒绝：${role} 无权修改车站状态`;
        const incident = incidents.find((i) => i.id === incidentId);
        if (!incident) return "事件不存在";
        if (incident.status === "已收束") return "事件已收束，无法继续上报";
        const station = stations.find((s) => s.id === stationId);
        if (!station) return "车站不存在";
        const report: StationReport = { id: uid(), incidentId, stationId, status, note, actor: role, time: now() };
        const entry: TimelineEntry = { id: uid(), time: now(), actor: role, action: "上报车站状态", detail: `${station.name} → ${status}（${incident.title}）`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" };
        set((s) => ({
          ...applyReport(pickLedger(s), report, entry, station.name),
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "上报车站状态" as const, time: now(), detail: entry.detail, report, entry }]
        }));
        return null;
      },

      addPlan: (input) => {
        const { role, incidents } = get();
        if (!PLAN_OPERATORS.includes(role)) return `越权操作被拒绝：${role} 无权新建接驳计划`;
        const incident = incidents.find((i) => i.id === input.incidentId);
        if (!incident) return "关联事件不存在";
        if (incident.status === "已收束") return "只能为未收束的事件创建接驳计划";
        const plan: ShuttlePlan = { ...input, id: uid(), status: "草稿", approvals: [], vehicleIds: [], createdAt: now() };
        const entry: TimelineEntry = { id: uid(), time: now(), actor: role, action: "新建接驳计划", detail: `${incident.title}：${plan.vehicles} 辆、间隔 ${plan.interval} 分钟（草稿）`, phase: "接驳" };
        set((s) => ({
          plans: [plan, ...s.plans],
          timeline: [entry, ...s.timeline],
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "更新接驳计划" as const, time: now(), detail: entry.detail, plan, entry }]
        }));
        return null;
      },

      submitPlan: (id) => {
        const { role, plans, poolSize } = get();
        if (!PLAN_OPERATORS.includes(role)) return `越权操作被拒绝：${role} 无权提交接驳计划`;
        const plan = plans.find((p) => p.id === id);
        if (!plan) return "计划不存在";
        if (plan.status !== "草稿") return "仅草稿计划可提交确认";
        // 车辆池共享：容量见底（或已有计划在排队）时新计划先排队
        const hasQueued = plans.some((p) => p.status === "排队中");
        const alloc = hasQueued ? null : tryAllocate(plans, poolSize, plan.vehicles);
        const next: ShuttlePlan = alloc ? { ...plan, status: "待确认", vehicleIds: alloc } : { ...plan, status: "排队中", vehicleIds: [] };
        const entry: TimelineEntry = {
          id: uid(),
          time: now(),
          actor: role,
          action: alloc ? "提交接驳计划" : "接驳计划排队",
          detail: alloc ? `计划 ${shortId(id)} 占用 ${alloc.join("、")}，等待跨岗位确认` : `车辆池容量不足，计划 ${shortId(id)}（${plan.vehicles} 辆）先排队`,
          phase: "接驳"
        };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? next : p)),
          timeline: [entry, ...s.timeline],
          statements: alloc ? invalidateStatements(s.statements, `接驳车辆数变动：计划 ${shortId(id)} 占用 ${alloc.length} 辆`) : s.statements,
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "更新接驳计划" as const, time: now(), detail: entry.detail, plan: next, entry }]
        }));
        return null;
      },

      updatePlanVehicles: (id, vehicles) => {
        const { role, plans, poolSize } = get();
        if (!PLAN_OPERATORS.includes(role)) return `越权操作被拒绝：${role} 无权调整车辆数`;
        const plan = plans.find((p) => p.id === id);
        if (!plan) return "计划不存在";
        if (plan.status === "已结束") return "计划已结束，不能再调整车辆数";
        if (!Number.isInteger(vehicles) || vehicles < 1 || vehicles > poolSize) return `车辆数需在 1-${poolSize} 之间`;
        let nextPlans: ShuttlePlan[];
        if (plan.status === "草稿") {
          nextPlans = plans.map((p) => (p.id === id ? { ...p, vehicles } : p));
        } else {
          // 先退回原来的占用，确认过的计划回到待确认，再随排队队列统一重新分配
          const released: ShuttlePlan = { ...plan, vehicles, vehicleIds: [], approvals: [], status: "排队中" };
          nextPlans = retryQueuedPlans(plans.map((p) => (p.id === id ? released : p)), poolSize).plans;
        }
        const next = nextPlans.find((p) => p.id === id)!;
        const wasConfirmed = plan.status === "已确认" || plan.status === "已执行";
        const entry: TimelineEntry = {
          id: uid(),
          time: now(),
          actor: role,
          action: "调整车辆数",
          detail: `计划 ${shortId(id)} ${plan.vehicles} → ${vehicles} 辆，原占用已退回重新分配${wasConfirmed ? "，已确认状态回退为待确认" : ""}${next.status === "排队中" ? "，容量不足进入排队" : ""}`,
          phase: "接驳"
        };
        set((s) => ({
          plans: nextPlans,
          timeline: [entry, ...s.timeline],
          statements: invalidateStatements(s.statements, `接驳车辆数变动：计划 ${shortId(id)} ${plan.vehicles} → ${vehicles} 辆`),
          conflicts: reconcileConflicts(s.conflicts, nextPlans),
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "更新接驳计划" as const, time: now(), detail: entry.detail, plan: next, entry }]
        }));
        return null;
      },

      approvePlan: (id) => {
        const { role, plans } = get();
        if (!PLAN_APPROVERS.includes(role)) return `越权确认被拒绝：${role} 无权确认接驳计划`;
        const plan = plans.find((p) => p.id === id);
        if (!plan) return "计划不存在";
        if (plan.status !== "待确认") return `计划当前为「${plan.status}」，不能确认`;
        if (plan.approvals.includes(role)) return "本岗位已确认过该计划，需等待另一岗位";
        const approvals = [...plan.approvals, role];
        const confirmed = PLAN_APPROVERS.every((r) => approvals.includes(r));
        const entry: TimelineEntry = {
          id: uid(),
          time: now(),
          actor: role,
          action: "确认接驳计划",
          detail: `计划 ${shortId(id)} 经 ${role} 确认${confirmed ? "，跨岗位确认完成" : "，等待另一岗位确认"}`,
          phase: "接驳"
        };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? { ...p, approvals, status: confirmed ? "已确认" as const : p.status } : p)),
          timeline: [entry, ...s.timeline]
        }));
        return null;
      },

      executePlan: (id) => {
        const { role, plans } = get();
        if (!PLAN_OPERATORS.includes(role)) return `越权操作被拒绝：${role} 无权执行接驳计划`;
        const plan = plans.find((p) => p.id === id);
        if (!plan) return "计划不存在";
        if (plan.status !== "已确认") return "仅已确认计划可执行";
        const entry: TimelineEntry = { id: uid(), time: now(), actor: role, action: "执行接驳计划", detail: `计划 ${shortId(id)} 车辆和站点岗位已收到调度指令`, phase: "接驳" };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? { ...p, status: "已执行" as const } : p)),
          timeline: [entry, ...s.timeline]
        }));
        return null;
      },

      publishStatement: (content) => {
        const { role } = get();
        if (role !== "客服主管") return `越权操作被拒绝：${role} 无权发布对外口径`;
        const statement: Statement = { id: uid(), content, author: role, time: now(), valid: true };
        const entry: TimelineEntry = { id: uid(), time: now(), actor: role, action: "发布对外口径", detail: content, phase: "响应" };
        set((s) => ({
          statements: [statement, ...s.statements],
          timeline: [entry, ...s.timeline],
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "发布对外口径" as const, time: now(), detail: content, statement, entry }]
        }));
        return null;
      },

      addTimeline: (action, detail, phase) => {
        const entry: TimelineEntry = { id: uid(), time: now(), actor: get().role, action, detail, phase };
        set((s) => ({
          timeline: [entry, ...s.timeline],
          pendingActions: s.online ? s.pendingActions : [...s.pendingActions, { id: uid(), kind: "处置记录" as const, time: now(), detail, entry }]
        }));
      },

      syncActions: () => {
        const state = get();
        if (!state.pendingActions.length) return;
        const server = readServerSnapshot() ?? pickLedger(state);
        const merged = mergePendingActions(server, state.pendingActions);
        const conflictCount = merged.conflicts.filter((c) => !c.resolved).length;
        const entry: TimelineEntry = {
          id: uid(),
          time: now(),
          actor: state.role,
          action: "同步本地队列",
          detail: `网络恢复，按事件+车站合并 ${state.pendingActions.length} 条离线操作${conflictCount ? `，留下 ${conflictCount} 条车辆冲突待处理` : "，无车辆冲突"}`,
          phase: "同步"
        };
        set({ ...merged, timeline: [entry, ...merged.timeline], pendingActions: [] });
      }
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => serverStorage),
      partialize: (s) => ({
        incidents: s.incidents,
        stations: s.stations,
        reports: s.reports,
        plans: s.plans,
        statements: s.statements,
        conflicts: s.conflicts,
        timeline: s.timeline,
        poolSize: s.poolSize,
        online: s.online
      })
    }
  )
);
