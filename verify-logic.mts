/* 逻辑验证脚本：模拟 localStorage（充当服务端），直接驱动 store 验证需求行为 */
const data = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); }
  }
};

const { useIncidentStore, deriveStationViews, allocatedVehicleIds } = await import("./store/incident");

const s = () => useIncidentStore.getState();
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// 1. 车站对外状态 = 未收束事件中最严重的一条（会展中心站被两条事件同时覆盖，互不覆盖）
let views = deriveStationViews(s().stations, s().incidents, s().reports);
check("会展中心站被两事件覆盖时取最严重（封闭）", views.find((v) => v.id === "s2")!.status === "封闭" && views.find((v) => v.id === "s2")!.sourceIncidentTitle === "会展中心站信号故障");
check("滨江站封闭（积水事件）", views.find((v) => v.id === "s1")!.status === "封闭");

// 2. 越权收束被拒绝；调度员收束后立即重算，旧状态不再挂着
s().setRole("车站值班员");
check("非调度员收束事件被拒绝", s().closeIncident("INC-20261006-02") !== null);
s().setRole("调度员");
check("调度员收束事件", s().closeIncident("INC-20261006-02") === null);
views = deriveStationViews(s().stations, s().incidents, s().reports);
check("收束信号故障后会展中心站立即回落为限流", views.find((v) => v.id === "s2")!.status === "限流");
check("收束后原对外口径失效", s().statements.every((st) => !st.valid));

// 3. 共享车辆池：容量见底新计划先排队
check("初始占用 8/12", allocatedVehicleIds(s().plans).size === 8);
s().addPlan({ incidentId: "INC-20261006-01", stations: ["s1", "s3"], vehicles: 5, interval: 8, operator: "东城公交", note: "加班接驳" });
const draft = s().plans[0];
s().submitPlan(draft.id);
check("池子只剩 4 辆，5 辆计划排队", s().plans.find((p) => p.id === draft.id)!.status === "排队中");

// 4. 改车辆数：退回原占用再分配，确认过的回到待确认，排队计划补位
s().updatePlanVehicles("p1", 4);
const p1 = () => s().plans.find((p) => p.id === "p1")!;
check("p1 改 4 辆后回待确认、占用重分、确认记录清空", p1().status === "待确认" && p1().vehicleIds.length === 4 && p1().approvals.length === 0);
check("排队计划补位成功", s().plans.find((p) => p.id === draft.id)!.status === "待确认");

// 5. 越权确认被拒绝；双方确认后才已确认
s().setRole("客服主管");
check("客服主管确认计划被拒绝", s().approvePlan("p1") !== null);
s().setRole("公交接驳负责人");
check("公交接驳负责人确认 p1", s().approvePlan("p1") === null);
check("单方确认后仍是待确认", p1().status === "待确认");
s().setRole("调度员");
check("调度员确认 p1", s().approvePlan("p1") === null);
check("双方确认后 p1 已确认", p1().status === "已确认");
check("同岗位重复确认被拒绝", s().approvePlan("p1") !== null);

// 6. 客服主管口径：越权发布被拒；车站状态变动后失效
s().setRole("车站值班员");
check("值班员发布口径被拒绝", s().publishStatement("测试") !== null);
s().setRole("客服主管");
check("客服主管发布口径", s().publishStatement("全线接驳已加密班次。") === null);
check("新口径有效", s().statements[0].valid);
s().setRole("车站值班员");
s().reportStationStatus("INC-20261006-01", "s3", "限流", "换乘客流增大");
check("车站状态变动后口径失效", !s().statements[0].valid && s().statements[0].invalidReason!.includes("车站状态变动"));

// 7. 弱网：本地队列 → 恢复后按事件+车站合并（同事件同站只留最新）
const before = s().reports.filter((r) => r.incidentId === "INC-20261006-01" && r.stationId === "s3").length;
s().setOnline(false);
s().reportStationStatus("INC-20261006-01", "s3", "封闭", "积水倒灌");
s().reportStationStatus("INC-20261006-01", "s3", "限流", "水位回落");
s().addTimeline("更新处置", "现场排水作业中", "响应");
check("弱网期间 3 条操作进入本地队列", s().pendingActions.length === 3);
check("弱网期间服务端快照未被写入", !JSON.parse(data.get("pair-wise-yf-47/ledger")!).state.reports.some((r: any) => r.note === "水位回落"));
s().setOnline(true);
check("恢复在线后队列自动合并清空", s().pendingActions.length === 0);
const after = s().reports.filter((r) => r.incidentId === "INC-20261006-01" && r.stationId === "s3");
check("同事件同站合并只留最新一条", after.length === before + 1 && after[0].status === "限流");
views = deriveStationViews(s().stations, s().incidents, s().reports);
check("合并后东港站为限流", views.find((v) => v.id === "s3")!.status === "限流");

// 8. 冲突：离线期间另一终端占用同一辆车，合并后留下冲突
s().setRole("调度员");
s().setOnline(false);
s().addPlan({ incidentId: "INC-20261006-01", stations: ["s2", "s3"], vehicles: 2, interval: 10, operator: "西城公交", note: "区间接驳" });
const offlinePlan = s().plans[0];
s().submitPlan(offlinePlan.id);
const heldVehicles = s().plans.find((p) => p.id === offlinePlan.id)!.vehicleIds;
check("离线提交计划本地占用车辆", heldVehicles.length === 2);
// 模拟另一终端：服务端快照里新增一条计划占用同一辆车
const serverState = JSON.parse(data.get("pair-wise-yf-47/ledger")!);
serverState.state.plans.unshift({ id: "px-remote", incidentId: "INC-20261006-01", stations: ["s1", "s2"], vehicles: 1, vehicleIds: [heldVehicles[0]], interval: 5, operator: "远程公交", status: "待确认", approvals: [], note: "另一终端提交", createdAt: new Date().toISOString() });
data.set("pair-wise-yf-47/ledger", JSON.stringify(serverState));
s().setOnline(true);
const conflict = s().conflicts.find((c) => !c.resolved && c.vehicleId === heldVehicles[0]);
check("同一辆车被两条计划占用留下冲突", !!conflict && conflict.planIds.includes(offlinePlan.id) && conflict.planIds.includes("px-remote"));
check("冲突双方占用都保留（不静默丢弃）", s().plans.filter((p) => p.vehicleIds.includes(heldVehicles[0])).length === 2);
// 改车辆数退回占用后冲突解除
s().setRole("调度员");
s().updatePlanVehicles(offlinePlan.id, 1);
check("改车辆退回占用后冲突解除", s().conflicts.filter((c) => c.vehicleId === heldVehicles[0]).every((c) => c.resolved));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
