import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type EventStatus = "进行中" | "已结束";
export type PlanStatus = "草稿" | "排队" | "待确认" | "已确认" | "已执行" | "已完成";
export type StatementStatus = "有效" | "已失效";

export const VEHICLE_POOL_CAPACITY = 80;
export const SEVERITY_RANK: Record<StationStatus, number> = { 正常: 0, 恢复中: 1, 限流: 2, 封闭: 3 };
export const PLAN_REQUIRED_ROLES: Role[] = ["调度员", "公交接驳负责人"];

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

/** 对外视图：状态由未结束事件推导，不再是车站自身的可变字段。 */
export type ViewStation = Station & { status: StationStatus };

export interface Event {
  id: string;
  title: string;
  section: string;
  severity: StationStatus;
  status: EventStatus;
  stationIds: string[];
  startedAt: string;
  endedAt?: string;
  reportedBy: Role;
  note: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Role[];
  requiredRoles: Role[];
  note: string;
  allocated: boolean;
  pendingSync?: boolean;
  queuedAt?: string;
}

export interface Statement {
  id: string;
  content: string;
  publishedBy: Role;
  publishedAt: string;
  status: StatementStatus;
  invalidReason?: string;
}

export interface Conflict {
  id: string;
  type: "车辆超额";
  planIds: string[];
  detail: string;
  time: string;
  resolved: boolean;
}

export interface PendingAction {
  id: string;
  kind: "station_status" | "event_close" | "plan_add" | "plan_submit" | "plan_edit" | "plan_approve" | "plan_execute" | "plan_complete" | "timeline" | "statement";
  action: string;
  detail: string;
  time: string;
  stationId?: string;
  eventId?: string;
  planId?: string;
}

export type ActionResult = { ok: boolean; error?: string };

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  events: Event[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  statements: Statement[];
  conflicts: Conflict[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  reportStationStatus: (id: string, status: StationStatus, note?: string) => ActionResult;
  closeEvent: (id: string) => ActionResult;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals" | "requiredRoles" | "allocated">) => void;
  submitPlan: (id: string) => ActionResult;
  approvePlan: (id: string, role: Role) => ActionResult;
  executePlan: (id: string) => ActionResult;
  completePlan: (id: string) => ActionResult;
  updatePlanVehicles: (id: string, vehicles: number) => ActionResult;
  publishStatement: (content: string) => ActionResult;
  resolveConflict: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
}

const now = () => new Date().toISOString();

/** 车站对外状态：取所有覆盖该车站的未结束事件里最严重的一条；无则正常。 */
export function deriveStationStatus(events: Event[], stationId: string): StationStatus {
  const active = events.filter((event) => event.status === "进行中" && event.stationIds.includes(stationId));
  if (!active.length) return "正常";
  return active.reduce<StationStatus>((worst, event) => (SEVERITY_RANK[event.severity] > SEVERITY_RANK[worst] ? event.severity : worst), "正常");
}

export function allocatedVehicles(plans: ShuttlePlan[]): number {
  return plans.filter((plan) => plan.allocated).reduce((sum, plan) => sum + plan.vehicles, 0);
}

function invalidateStatements(statements: Statement[], reason: string): Statement[] {
  return statements.map((statement) => (statement.status === "有效" ? { ...statement, status: "已失效" as const, invalidReason: reason } : statement));
}

/** 释放已完成计划占用的车辆后，按排队先后把等待中的计划顶上。 */
function recomputeQueue(plans: ShuttlePlan[], capacity: number): ShuttlePlan[] {
  let used = allocatedVehicles(plans);
  const queued = plans
    .filter((plan) => plan.status === "排队")
    .sort((a, b) => (a.queuedAt ?? "").localeCompare(b.queuedAt ?? ""));
  const promoted = new Map<string, ShuttlePlan>();
  for (const plan of queued) {
    if (used + plan.vehicles <= capacity) {
      used += plan.vehicles;
      promoted.set(plan.id, { ...plan, allocated: true, status: "待确认", approvals: [] });
    }
  }
  return plans.map((plan) => promoted.get(plan.id) ?? plan);
}

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const seedEvents: Event[] = [
  { id: "ev1", title: "滨江站区间积水停运", section: "中心-滨江", severity: "封闭", status: "进行中", stationIds: ["s1"], startedAt: new Date(Date.now() - 35 * 60000).toISOString(), reportedBy: "调度员", note: "站台积水，已启动公交接驳" },
  { id: "ev2", title: "会展中心站大客流", section: "会展-滨江", severity: "限流", status: "进行中", stationIds: ["s2"], startedAt: new Date(Date.now() - 27 * 60000).toISOString(), reportedBy: "车站值班员", note: "出入口单向组织" }
];

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set, get) => ({
      incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
      stations: seedStations,
      events: seedEvents,
      timeline: [
        { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
        { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
      ],
      plans: [
        { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], requiredRoles: PLAN_REQUIRED_ROLES, note: "优先疏运站外滞留乘客", allocated: true, queuedAt: new Date(Date.now() - 20 * 60000).toISOString() }
      ],
      statements: [],
      conflicts: [],
      role: "调度员",
      online: true,
      pendingActions: [],
      setRole: (role) => set({ role }),
      setOnline: (online) => set({ online }),

      reportStationStatus: (id, status, note) => {
        const state = get();
        const station = state.stations.find((item) => item.id === id);
        if (!station) return { ok: false, error: "车站不存在" };
        const event: Event = {
          id: crypto.randomUUID(),
          title: `${station.name}${status}事件`,
          section: station.section,
          severity: status,
          status: "进行中",
          stationIds: [id],
          startedAt: now(),
          reportedBy: state.role,
          note: note ?? station.note
        };
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "上报车站状态",
          detail: `${station.name} → ${status}（挂接事件「${event.title}」）`,
          phase: status === "正常" || status === "恢复中" ? "恢复" : "响应"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "station_status", action: "上报车站状态", detail: `${station.name} → ${status}`, time: now(), stationId: id, eventId: event.id }];
        set({
          events: [event, ...state.events],
          stations: state.stations.map((item) => (item.id === id ? { ...item, updatedAt: now() } : item)),
          timeline: [timeline, ...state.timeline],
          statements: invalidateStatements(state.statements, "车站状态变动，对外口径失效"),
          pendingActions: [...pending, ...state.pendingActions]
        });
        return { ok: true };
      },

      closeEvent: (id) => {
        const state = get();
        const event = state.events.find((item) => item.id === id);
        if (!event || event.status !== "进行中") return { ok: false, error: "事件不存在或已结束" };
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "收束事件",
          detail: `「${event.title}」已结束，相关车站对外状态立即重算`,
          phase: "恢复"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "event_close", action: "收束事件", detail: event.title, time: now(), eventId: id }];
        set({
          events: state.events.map((item) => (item.id === id ? { ...item, status: "已结束", endedAt: now() } : item)),
          timeline: [timeline, ...state.timeline],
          statements: invalidateStatements(state.statements, "事件收束，车站状态重算，对外口径失效"),
          pendingActions: [...pending, ...state.pendingActions]
        });
        return { ok: true };
      },

      addTimeline: (entry) =>
        set((state) => ({
          timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline],
          pendingActions: state.online
            ? state.pendingActions
            : [{ id: crypto.randomUUID(), kind: "timeline", action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions]
        })),

      addPlan: (plan) => {
        const state = get();
        const newPlan: ShuttlePlan = { ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [], requiredRoles: PLAN_REQUIRED_ROLES, allocated: false };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "plan_add", action: "新建接驳计划", detail: `${plan.stations.join(" → ")}，${plan.vehicles} 辆`, time: now(), planId: newPlan.id }];
        set({ plans: [newPlan, ...state.plans], pendingActions: [...pending, ...state.pendingActions] });
      },

      submitPlan: (id) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan || plan.status !== "草稿") return { ok: false, error: "仅草稿可提交" };
        const free = VEHICLE_POOL_CAPACITY - allocatedVehicles(state.plans);
        let updated: ShuttlePlan;
        let pending: PendingAction[] = [];
        if (!state.online) {
          // 弱网：先记本地队列，占用按乐观分配，恢复后统一合并
          updated = { ...plan, status: "待确认", allocated: true, pendingSync: true, queuedAt: now() };
          pending = [{ id: crypto.randomUUID(), kind: "plan_submit", action: "提交接驳计划", detail: `${plan.stations.join(" → ")}，${plan.vehicles} 辆`, time: now(), planId: id }];
        } else if (free >= plan.vehicles) {
          updated = { ...plan, status: "待确认", allocated: true, queuedAt: now() };
        } else {
          updated = { ...plan, status: "排队", allocated: false, queuedAt: now() };
        }
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "提交接驳计划",
          detail: updated.status === "排队" ? `车辆池容量不足（空闲 ${free} / 需 ${plan.vehicles}），计划进入排队` : `计划 ${id.slice(0, 6)} 占用 ${plan.vehicles} 辆，等待跨岗位确认`,
          phase: "接驳"
        };
        set({ plans: state.plans.map((item) => (item.id === id ? updated : item)), timeline: [timeline, ...state.timeline], pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      approvePlan: (id, role) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan) return { ok: false, error: "计划不存在" };
        if (plan.status !== "待确认") return { ok: false, error: "当前状态不可确认" };
        if (!plan.requiredRoles.includes(role)) {
          return { ok: false, error: `越权拒绝：${role} 不在该计划确认岗位（需 ${plan.requiredRoles.join("、")}）` };
        }
        if (plan.approvals.includes(role)) return { ok: false, error: `${role} 已确认，无需重复` };
        const approvals = [...plan.approvals, role];
        const status: PlanStatus = plan.requiredRoles.every((required) => approvals.includes(required)) ? "已确认" : "待确认";
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: role,
          action: "确认接驳计划",
          detail: `${role} 已确认计划 ${id.slice(0, 6)}${status === "已确认" ? "，全部岗位确认完毕" : ""}`,
          phase: "接驳"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "plan_approve", action: "确认接驳计划", detail: `${role} 确认 ${id.slice(0, 6)}`, time: now(), planId: id }];
        set({ plans: state.plans.map((item) => (item.id === id ? { ...item, approvals, status } : item)), timeline: [timeline, ...state.timeline], pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      executePlan: (id) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan || plan.status !== "已确认") return { ok: false, error: "仅已确认计划可执行" };
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "执行接驳计划",
          detail: `计划 ${id.slice(0, 6)} 已下发，${plan.vehicles} 辆到场`,
          phase: "接驳"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "plan_execute", action: "执行接驳计划", detail: id.slice(0, 6), time: now(), planId: id }];
        set({ plans: state.plans.map((item) => (item.id === id ? { ...item, status: "已执行" } : item)), timeline: [timeline, ...state.timeline], pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      completePlan: (id) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan || plan.status !== "已执行") return { ok: false, error: "仅执行中的计划可完成并释放车辆" };
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "完成接驳计划",
          detail: `计划 ${id.slice(0, 6)} 已完成，释放 ${plan.vehicles} 辆回池，排队计划重新分配`,
          phase: "接驳"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "plan_complete", action: "完成接驳计划", detail: id.slice(0, 6), time: now(), planId: id }];
        const plans = recomputeQueue(state.plans.map((item) => (item.id === id ? { ...item, status: "已完成", allocated: false } : item)), VEHICLE_POOL_CAPACITY);
        set({ plans, timeline: [timeline, ...state.timeline], statements: invalidateStatements(state.statements, "接驳车辆数变动，对外口径失效"), pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      updatePlanVehicles: (id, vehicles) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan) return { ok: false, error: "计划不存在" };
        if (!["草稿", "待确认", "已确认"].includes(plan.status)) return { ok: false, error: "当前状态不可调整车辆" };
        if (vehicles < 1 || vehicles > VEHICLE_POOL_CAPACITY) return { ok: false, error: `车辆数需在 1~${VEHICLE_POOL_CAPACITY} 之间` };
        const wasConfirmed = plan.status === "已确认";
        // 先退回原占用，再按新数量重新分配
        let plans = state.plans.map((item) => (item.id === id ? { ...item, allocated: false } : item));
        plans = plans.map((item) => (item.id === id ? { ...item, vehicles } : item));
        const used = allocatedVehicles(plans.filter((item) => item.id !== id));
        const free = VEHICLE_POOL_CAPACITY - used;
        const current = plans.find((item) => item.id === id)!;
        let updated: ShuttlePlan;
        if (current.status === "草稿") {
          updated = { ...current, allocated: false };
        } else if (free >= vehicles) {
          updated = { ...current, allocated: true, status: wasConfirmed ? "待确认" : current.status, approvals: wasConfirmed ? [] : current.approvals };
        } else {
          updated = { ...current, allocated: false, status: "排队" };
        }
        plans = plans.map((item) => (item.id === id ? updated : item));
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "调整接驳车辆数",
          detail: `${id.slice(0, 6)} 改为 ${vehicles} 辆：退回原占用后重新分配${wasConfirmed ? "，已确认计划回到待确认" : updated.status === "排队" ? "，容量不足进入排队" : ""}`,
          phase: "接驳"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "plan_edit", action: "调整接驳车辆数", detail: `${id.slice(0, 6)} → ${vehicles} 辆`, time: now(), planId: id }];
        set({ plans, timeline: [timeline, ...state.timeline], statements: invalidateStatements(state.statements, "接驳车辆数变动，对外口径失效"), pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      publishStatement: (content) => {
        const state = get();
        if (state.role !== "客服主管") return { ok: false, error: "越权拒绝：仅客服主管可发布对外口径" };
        if (!content.trim()) return { ok: false, error: "口径内容不能为空" };
        const statement: Statement = { id: crypto.randomUUID(), content: content.trim(), publishedBy: state.role, publishedAt: now(), status: "有效" };
        const timeline: TimelineEntry = {
          id: crypto.randomUUID(),
          time: now(),
          actor: state.role,
          action: "发布对外口径",
          detail: content.trim().slice(0, 24),
          phase: "响应"
        };
        const pending: PendingAction[] = state.online
          ? []
          : [{ id: crypto.randomUUID(), kind: "statement", action: "发布对外口径", detail: content.trim().slice(0, 24), time: now() }];
        set({ statements: [statement, ...state.statements], timeline: [timeline, ...state.timeline], pendingActions: [...pending, ...state.pendingActions] });
        return { ok: true };
      },

      resolveConflict: (id) => set((state) => ({ conflicts: state.conflicts.map((item) => (item.id === id ? { ...item, resolved: true } : item)) })),

      queueAction: (action, detail) =>
        set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), kind: "timeline", action, detail, time: now() }, ...state.pendingActions] })),

      syncActions: () =>
        set((state) => {
          const actions = state.pendingActions;
          // 按车站合并车站状态上报：同一车站只保留最新一条（事件已在本地乐观挂接）
          const stationLatest = new Map<string, PendingAction>();
          for (const action of actions) {
            if (action.kind === "station_status" && action.stationId) {
              const prev = stationLatest.get(action.stationId);
              if (!prev || action.time > prev.time) stationLatest.set(action.stationId, action);
            }
          }
          // 合并后重新核算车辆占用；若离线乐观分配导致超额，留下冲突
          let plans = state.plans.map((item) => (item.pendingSync ? { ...item, pendingSync: false } : item));
          const used = allocatedVehicles(plans);
          const conflicts = [...state.conflicts];
          if (used > VEHICLE_POOL_CAPACITY) {
            const overPlans = plans.filter((item) => item.allocated);
            conflicts.unshift({
              id: crypto.randomUUID(),
              type: "车辆超额",
              planIds: overPlans.map((item) => item.id),
              detail: `本地队列合并后 ${overPlans.length} 条计划共占用 ${used} 辆，超过池子容量 ${VEHICLE_POOL_CAPACITY} 辆，同一辆车被多条计划重复占用`,
              time: now(),
              resolved: false
            });
          } else {
            plans = recomputeQueue(plans, VEHICLE_POOL_CAPACITY);
          }
          const timeline: TimelineEntry = {
            id: crypto.randomUUID(),
            time: now(),
            actor: state.role,
            action: "同步本地队列",
            detail: `已合并 ${actions.length} 条本地操作（车站状态按车站合并 ${stationLatest.size} 条）${conflicts.length > state.conflicts.length ? "，发现车辆占用冲突" : ""}`,
            phase: "响应"
          };
          return { plans, conflicts, pendingActions: [], timeline: [timeline, ...state.timeline] };
        })
    }),
    { name: "pair-wise-yf-47/incident" }
  )
);
