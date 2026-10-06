"use client";

import { useState } from "react";
import { App as AntApp, Alert, Badge, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Progress, Segmented, Select, Space, Statistic, Table, Tag, Timeline } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  deriveStationViews,
  allocatedVehicleIds,
  shortId,
  PLAN_OPERATORS,
  STATION_REPORTERS,
  type Incident,
  type IncidentStatus,
  type Role,
  type ShuttlePlan,
  type StationStatus,
  type StationView
} from "../store/incident";

const planSchema = z.object({
  incidentId: z.string().min(1, "请选择关联事件"),
  stations: z.array(z.string()).min(2, "至少选择两个接驳站"),
  vehicles: z.number().min(1, "至少 1 辆"),
  interval: z.number().min(2, "间隔 2-30 分钟").max(30, "间隔 2-30 分钟"),
  operator: z.string().min(2, "请填写运营方"),
  note: z.string().min(2, "请填写计划说明")
});
type PlanForm = z.infer<typeof planSchema>;

const stationStatusColor: Record<StationStatus, string> = { 封闭: "red", 限流: "orange", 恢复中: "blue", 正常: "green" };
const incidentStatusColor: Record<IncidentStatus, string> = { 处置中: "red", 控制中: "orange", 已收束: "default" };
const planStatusColor: Record<string, string> = { 草稿: "default", 排队中: "gold", 待确认: "orange", 已确认: "green", 已执行: "blue", 已结束: "default" };
const phaseColor: Record<string, string> = { 发现: "red", 响应: "orange", 接驳: "blue", 恢复: "green", 同步: "purple" };

function Dashboard() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const state = useIncidentStore();
  const [panel, setPanel] = useState("总览");
  const [planModal, setPlanModal] = useState(false);
  const [incidentModal, setIncidentModal] = useState(false);
  const [incidentForm, setIncidentForm] = useState({ title: "", section: "" });
  const [reportTarget, setReportTarget] = useState<StationView | null>(null);
  const [reportForm, setReportForm] = useState<{ incidentId?: string; status: StationStatus; note: string }>({ status: "限流", note: "" });
  const [vehicleTarget, setVehicleTarget] = useState<ShuttlePlan | null>(null);
  const [vehicleCount, setVehicleCount] = useState(4);
  const [statement, setStatement] = useState("");
  const [recordDetail, setRecordDetail] = useState("");
  const [recordPhase, setRecordPhase] = useState<"发现" | "响应" | "接驳" | "恢复">("响应");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({
    defaultValues: { incidentId: "", stations: [], vehicles: 4, interval: 6, operator: "东城公交", note: "" }
  });

  const views = deriveStationViews(state.stations, state.incidents, state.reports);
  const openIncidents = state.incidents.filter((item) => item.status !== "已收束");
  const usedVehicles = allocatedVehicleIds(state.plans).size;
  const queuedPlans = state.plans.filter((item) => item.status === "排队中");
  const activeConflicts = state.conflicts.filter((item) => !item.resolved);
  const stationName = (id: string) => state.stations.find((item) => item.id === id)?.name ?? id;
  const incidentTitle = (id: string) => state.incidents.find((item) => item.id === id)?.title ?? id;
  const canOperatePlans = PLAN_OPERATORS.includes(state.role);
  const canReport = STATION_REPORTERS.includes(state.role);

  const run = (error: string | null) => { if (error) message.error(error); };

  const stationColumns: ColumnsType<StationView> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "对外状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={stationStatusColor[value]}>{value}</Tag> },
    {
      title: "状态来源",
      dataIndex: "sourceIncidentTitle",
      render: (value: string | undefined, record) =>
        value ? <span>{value}<br /><small>{format(new Date(record.updatedAt), "HH:mm:ss")}</small></span> : "—"
    },
    { title: "现场说明", dataIndex: "note" },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    {
      title: "处置",
      render: (_, record) => (
        <Button
          size="small"
          disabled={!canReport || !openIncidents.length}
          onClick={() => { setReportTarget(record); setReportForm({ incidentId: openIncidents[0]?.id, status: "限流", note: "" }); }}
        >
          上报状态
        </Button>
      )
    }
  ];

  const incidentColumns: ColumnsType<Incident> = [
    { title: "事件", dataIndex: "title", render: (value, record) => <span><b>{value}</b><br /><small>{record.id}</small></span> },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: IncidentStatus) => <Tag color={incidentStatusColor[value]}>{value}</Tag> },
    { title: "启动于", dataIndex: "startedAt", render: (value: string) => format(new Date(value), "MM-dd HH:mm") },
    {
      title: "操作",
      render: (_, record) =>
        record.status !== "已收束" ? (
          <Popconfirm title="收束后车站对外状态将立即重算，其接驳计划结束并释放车辆" onConfirm={() => run(state.closeIncident(record.id))}>
            <Button size="small" danger disabled={state.role !== "调度员"}>收束事件</Button>
          </Popconfirm>
        ) : (
          <small>收束于 {record.closedAt ? format(new Date(record.closedAt), "MM-dd HH:mm") : "—"}</small>
        )
    }
  ];

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "关联事件", dataIndex: "incidentId", render: (value: string) => incidentTitle(value) },
    { title: "接驳站", dataIndex: "stations", render: (value: string[]) => value.map(stationName).join(" → ") },
    {
      title: "车辆",
      render: (_, record) => (
        <span>
          {record.vehicles} 辆
          {record.vehicleIds.length > 0 && <><br /><small>{record.vehicleIds.join("、")}</small></>}
        </span>
      )
    },
    { title: "间隔", dataIndex: "interval", render: (value: number) => `${value} 分钟` },
    { title: "运营方", dataIndex: "operator" },
    {
      title: "确认",
      dataIndex: "approvals",
      render: (value: Role[]) => (value.length ? value.map((item) => <Tag key={item} color="green">{item}</Tag>) : <Tag>未确认</Tag>)
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: string, record) => (
        <Space size={4} wrap>
          <Tag color={planStatusColor[value]}>{value}</Tag>
          {activeConflicts.some((c) => c.planIds.includes(record.id)) && <Tag color="red">车辆冲突</Tag>}
        </Space>
      )
    },
    {
      title: "操作",
      render: (_, record) => (
        <Space wrap>
          {record.status === "草稿" && <Button size="small" disabled={!canOperatePlans} onClick={() => run(state.submitPlan(record.id))}>提交确认</Button>}
          {record.status === "待确认" && <Button size="small" disabled={!state.online} onClick={() => run(state.approvePlan(record.id))}>确认</Button>}
          {record.status === "已确认" && <Button size="small" type="primary" disabled={!canOperatePlans || !state.online} onClick={() => run(state.executePlan(record.id))}>执行</Button>}
          {record.status !== "已结束" && (
            <Button size="small" disabled={!canOperatePlans} onClick={() => { setVehicleTarget(record); setVehicleCount(record.vehicles); }}>改车辆</Button>
          )}
        </Space>
      )
    }
  ];

  const submitPlanForm = (values: PlanForm) => {
    const parsed = planSchema.safeParse(values);
    if (!parsed.success) { message.error(parsed.error.issues[0]?.message ?? "表单校验失败"); return; }
    const error = state.addPlan(parsed.data);
    if (error) { message.error(error); return; }
    setPlanModal(false);
  };

  const publishStatement = () => {
    const content = statement.trim();
    if (content.length < 2) { message.error("请填写口径内容"); return; }
    const error = state.publishStatement(content);
    if (error) { message.error(error); return; }
    setStatement("");
    message.success("对外口径已发布");
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
        <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
        <div className="side-status">
          <small>系统连接</small>
          <b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b>
          <span>本地队列 {state.pendingActions.length} 条</span>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <small>{openIncidents.length} 起事件处置中 · 车辆池占用 {usedVehicles}/{state.poolSize} 辆</small>
            <h1>{t("title")}</h1>
            <p>{t("subtitle")}</p>
          </div>
          <Space>
            <Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} />
            <Select<Role> value={state.role} onChange={state.setRole} options={(["调度员", "车站值班员", "公交接驳负责人", "客服主管"] as Role[]).map((value) => ({ value, label: `角色：${value}` }))} />
          </Space>
        </header>
        <section className="metrics">
          <Card><Statistic title="进行中事件" value={openIncidents.length} suffix="起" /></Card>
          <Card><Statistic title="受影响车站" value={views.filter((item) => item.status !== "正常").length} suffix="座" /></Card>
          <Card><Statistic title="车辆池占用" value={usedVehicles} suffix={`/ ${state.poolSize} 辆`} /></Card>
          <Card><Statistic title="待同步操作" value={state.pendingActions.length} /></Card>
        </section>
        {!state.online && (
          <div className="degrade">
            当前处于弱网降级模式：操作先记入本地队列，网络恢复后自动按事件和车站合并同步；若同一辆车被两条计划同时占用，会保留为车辆冲突等待处理。
          </div>
        )}

        {panel === "总览" && (
          <>
            <section className="overview">
              <Card title={t("stations")} extra={<span className="pool-note">对外状态按未收束事件中最严重的一条推导</span>} className="wide">
                <Table rowKey="id" dataSource={views} columns={stationColumns} pagination={false} size="small" scroll={{ x: 860 }} />
              </Card>
              <Card title="受影响区段" className="map-card">
                <MapPanel stations={views} plans={state.plans.filter((plan) => ["待确认", "已确认", "已执行"].includes(plan.status))} />
              </Card>
            </section>
            <section className="overview">
              <Card
                title="事件列表"
                className="wide"
                extra={<Button size="small" type="primary" disabled={state.role !== "调度员"} onClick={() => setIncidentModal(true)}>新建事件</Button>}
              >
                <Table rowKey="id" dataSource={state.incidents} columns={incidentColumns} pagination={false} size="small" />
              </Card>
              <Card title="接驳车辆池">
                <Statistic title="已占用 / 总容量" value={usedVehicles} suffix={`/ ${state.poolSize} 辆`} />
                <Progress percent={Math.round((usedVehicles / state.poolSize) * 100)} status={usedVehicles >= state.poolSize ? "exception" : "active"} />
                <p className="pool-note">排队中计划 {queuedPlans.length} 条 · 未解车辆冲突 {activeConflicts.length} 条</p>
                <p className="pool-note">容量见底时新计划自动排队；事件收束或计划调整释放车辆后，排队计划按提交顺序补位。</p>
              </Card>
            </section>
          </>
        )}

        {panel === "事件时间线" && (
          <Card
            title="统一处置账 · 处置时间线"
            extra={
              <Space>
                <Select value={recordPhase} onChange={setRecordPhase} options={["发现", "响应", "接驳", "恢复"].map((value) => ({ value, label: value }))} style={{ width: 90 }} />
                <Input placeholder="处置内容" value={recordDetail} onChange={(e) => setRecordDetail(e.target.value)} style={{ width: 220 }} />
                <Button type="primary" onClick={() => { if (!recordDetail.trim()) return; state.addTimeline("更新处置", recordDetail.trim(), recordPhase); setRecordDetail(""); }}>添加处置记录</Button>
              </Space>
            }
          >
            <div className="timeline-grid">
              <Timeline
                items={state.timeline.map((item) => ({
                  color: phaseColor[item.phase] ?? "gray",
                  children: (
                    <div>
                      <b>{item.action}</b><Tag>{item.actor}</Tag>
                      <p>{item.detail}</p>
                      <small>{format(new Date(item.time), "MM-dd HH:mm:ss")} · {item.phase}</small>
                    </div>
                  )
                }))}
              />
              <Card size="small" title="处置检查">
                <p>车站封闭与广播口径已确认。</p>
                <p>接驳车辆到场后需调度员和公交负责人双方确认。</p>
                <p>恢复行车前检查区间水位和站台安全。</p>
              </Card>
            </div>
          </Card>
        )}

        {panel === "接驳计划" && (
          <Card
            title="公交接驳计划"
            extra={
              <Space>
                <span className="pool-note">车辆池 {usedVehicles}/{state.poolSize}{queuedPlans.length > 0 ? ` · ${queuedPlans.length} 条排队中` : ""}</span>
                <Button
                  type="primary"
                  disabled={!canOperatePlans || !openIncidents.length}
                  onClick={() => { reset({ incidentId: openIncidents[0]?.id ?? "", stations: [], vehicles: 4, interval: 6, operator: "东城公交", note: "" }); setPlanModal(true); }}
                >
                  新建计划
                </Button>
              </Space>
            }
          >
            {usedVehicles >= state.poolSize && <Alert type="warning" showIcon message="车辆池容量见底，新提交的计划将先排队，等待车辆释放后按顺序补位。" style={{ marginBottom: 12 }} />}
            <Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} size="small" scroll={{ x: 960 }} />
          </Card>
        )}

        {panel === "确认中心" && (
          <div className="confirm-grid">
            <Card title="跨岗位确认">
              <Alert type="info" showIcon message="计划需调度员与公交接驳负责人双方确认；只能以当前岗位身份确认，越权替其他岗位确认会被拒绝。" />
              <Timeline
                style={{ marginTop: 16 }}
                items={state.plans.filter((plan) => plan.status !== "草稿").map((plan) => ({
                  color: plan.status === "排队中" ? "gold" : "blue",
                  children: (
                    <div className="approval">
                      <b>{plan.stations.map(stationName).join(" → ")}</b><Tag>{plan.status}</Tag>
                      <p>{plan.vehicles} 辆 · 间隔 {plan.interval} 分钟 · {incidentTitle(plan.incidentId)}</p>
                      <small>已确认：{plan.approvals.join("、") || "暂无"}</small>
                      {plan.status === "待确认" && (
                        <div><Button size="small" disabled={!state.online} onClick={() => run(state.approvePlan(plan.id))}>以「{state.role}」身份确认</Button></div>
                      )}
                    </div>
                  )
                }))}
              />
            </Card>
            <Card title="对外口径">
              {state.role === "客服主管" ? (
                <Space.Compact style={{ width: "100%" }}>
                  <Input placeholder="发布对外口径…" value={statement} onChange={(e) => setStatement(e.target.value)} />
                  <Button type="primary" onClick={publishStatement}>发布</Button>
                </Space.Compact>
              ) : (
                <Alert type="warning" showIcon message="仅客服主管可发布对外口径；车站状态或车辆数变动后，已发布的口径自动失效。" />
              )}
              {state.statements.map((item) => (
                <div key={item.id} className={item.valid ? "stmt" : "stmt invalid"}>
                  <Space>
                    <Tag color={item.valid ? "green" : "default"}>{item.valid ? "有效" : "已失效"}</Tag>
                    <b>{item.author}</b>
                    <small>{format(new Date(item.time), "MM-dd HH:mm")}</small>
                  </Space>
                  <p>{item.content}</p>
                  {!item.valid && <small>失效原因：{item.invalidReason}</small>}
                </div>
              ))}
            </Card>
            <Card title="本地队列（弱网）">
              {state.pendingActions.length === 0 ? (
                <p className="pool-note">暂无待同步操作。弱网期间的操作会先记入本地队列，网络恢复后自动按事件和车站合并。</p>
              ) : (
                <>
                  {state.pendingActions.map((action) => (
                    <div className="queue-item" key={action.id}>
                      <span><Tag>{action.kind}</Tag>{action.detail}</span>
                      <small>{format(new Date(action.time), "HH:mm:ss")}</small>
                    </div>
                  ))}
                  <Button
                    type="primary"
                    disabled={!state.online}
                    style={{ marginTop: 12 }}
                    onClick={() => { state.syncActions(); message.success("本地队列已按事件和车站合并同步"); }}
                  >
                    立即合并同步
                  </Button>
                </>
              )}
            </Card>
            <Card title={`车辆冲突（${activeConflicts.length}）`}>
              {activeConflicts.length === 0 ? (
                <p className="pool-note">暂无冲突。同一辆车被两条计划同时占用时，会在这里留下冲突记录。</p>
              ) : (
                activeConflicts.map((conflict) => (
                  <div className="conflict-item" key={conflict.id}>
                    <b>车辆 {conflict.vehicleId}</b> 被计划 {conflict.planIds.map(shortId).join("、")} 同时占用
                    <br />
                    <small>{format(new Date(conflict.time), "MM-dd HH:mm:ss")} · 通过「改车辆」退回占用并重新分配后自动解除</small>
                  </div>
                ))
              )}
            </Card>
          </div>
        )}
      </main>

      <Modal title="新建接驳计划" open={planModal} onCancel={() => setPlanModal(false)} onOk={handleSubmit(submitPlanForm)} okText="保存草稿">
        <Form layout="vertical">
          <Form.Item label="关联事件" validateStatus={errors.incidentId ? "error" : ""} help={errors.incidentId?.message}>
            <Controller name="incidentId" control={control} render={({ field }) => <Select {...field} options={openIncidents.map((item) => ({ value: item.id, label: `${item.title}（${item.section}）` }))} />} />
          </Form.Item>
          <Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}>
            <Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.id, label: item.name }))} />} />
          </Form.Item>
          <Space>
            <Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} max={state.poolSize} />} /></Form.Item>
            <Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} max={30} addonAfter="分钟" />} /></Form.Item>
          </Space>
          <Form.Item label="运营方" validateStatus={errors.operator ? "error" : ""} help={errors.operator?.message}>
            <Controller name="operator" control={control} render={({ field }) => <Input {...field} />} />
          </Form.Item>
          <Form.Item label="计划说明" validateStatus={errors.note ? "error" : ""} help={errors.note?.message}>
            <Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新建事件"
        open={incidentModal}
        onCancel={() => setIncidentModal(false)}
        okText="启动事件"
        onOk={() => {
          if (!incidentForm.title.trim() || !incidentForm.section.trim()) { message.error("请填写事件标题和区段"); return; }
          const error = state.addIncident(incidentForm.title.trim(), incidentForm.section.trim());
          if (error) { message.error(error); return; }
          setIncidentModal(false);
          setIncidentForm({ title: "", section: "" });
        }}
      >
        <Form layout="vertical">
          <Form.Item label="事件标题" required><Input value={incidentForm.title} onChange={(e) => setIncidentForm({ ...incidentForm, title: e.target.value })} placeholder="如：东港站设备故障" /></Form.Item>
          <Form.Item label="影响区段" required><Input value={incidentForm.section} onChange={(e) => setIncidentForm({ ...incidentForm, section: e.target.value })} placeholder="如：滨江站—东港站" /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`上报车站状态 · ${reportTarget?.name ?? ""}`}
        open={!!reportTarget}
        onCancel={() => setReportTarget(null)}
        okText="上报"
        onOk={() => {
          if (!reportTarget || !reportForm.incidentId) { message.error("请选择关联事件"); return; }
          const error = state.reportStationStatus(reportForm.incidentId, reportTarget.id, reportForm.status, reportForm.note.trim());
          if (error) { message.error(error); return; }
          setReportTarget(null);
        }}
      >
        <Form layout="vertical">
          <Form.Item label="关联事件（未收束）" required>
            <Select value={reportForm.incidentId} onChange={(value) => setReportForm({ ...reportForm, incidentId: value })} options={openIncidents.map((item) => ({ value: item.id, label: item.title }))} />
          </Form.Item>
          <Form.Item label="上报状态" required>
            <Select<StationStatus> value={reportForm.status} onChange={(value) => setReportForm({ ...reportForm, status: value })} options={(["正常", "限流", "封闭", "恢复中"] as StationStatus[]).map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item label="现场说明"><Input.TextArea value={reportForm.note} onChange={(e) => setReportForm({ ...reportForm, note: e.target.value })} placeholder="现场情况、处置措施" /></Form.Item>
        </Form>
        <Alert type="info" showIcon message="同一车站被多条事件覆盖时，对外状态取未收束事件中最严重的一条，后报的状态不会盖掉其他事件的上报。" />
      </Modal>

      <Modal
        title={`调整车辆数 · 计划 ${vehicleTarget ? shortId(vehicleTarget.id) : ""}`}
        open={!!vehicleTarget}
        onCancel={() => setVehicleTarget(null)}
        okText="退回原占用并重新分配"
        onOk={() => {
          if (!vehicleTarget) return;
          const error = state.updatePlanVehicles(vehicleTarget.id, vehicleCount);
          if (error) { message.error(error); return; }
          setVehicleTarget(null);
        }}
      >
        <p className="pool-note">
          当前 {vehicleTarget?.vehicles} 辆（占用 {vehicleTarget?.vehicleIds.join("、") || "无"}）。调整后原占用先退回车辆池再重新分配；已确认的计划会回到待确认，需重新跨岗位确认。
        </p>
        <InputNumber min={1} max={state.poolSize} value={vehicleCount} onChange={(value) => setVehicleCount(Number(value ?? 1))} addonAfter="辆" />
      </Modal>
    </div>
  );
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
