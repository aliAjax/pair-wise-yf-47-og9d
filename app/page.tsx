"use client";

import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Alert, Badge, Button, Card, Form, Input, InputNumber, Modal, Segmented, Select, Space, Statistic, Table, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  deriveStationStatus,
  allocatedVehicles,
  VEHICLE_POOL_CAPACITY,
  type Role,
  type ShuttlePlan,
  type ViewStation,
  type StationStatus,
  type Event,
  type Statement
} from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const statusColor: Record<StationStatus, string> = { 封闭: "red", 限流: "orange", 恢复中: "blue", 正常: "green" };

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ShuttlePlan | null>(null);
  const [editVehicles, setEditVehicles] = useState(1);
  const [statement, setStatement] = useState("");
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const run = (result: { ok: boolean; error?: string }, okMsg?: string) => {
    if (result.ok) { if (okMsg) messageApi.success(okMsg); }
    else messageApi.error(result.error ?? "操作被拒绝");
  };

  // 车站对外状态：由未结束事件里最严重的一条推导
  const viewStations: ViewStation[] = useMemo(
    () => state.stations.map((station) => ({ ...station, status: deriveStationStatus(state.events, station.id) })),
    [state.stations, state.events]
  );
  const mapPlans = useMemo(() => state.plans.filter((plan) => plan.status !== "草稿" && plan.status !== "已完成"), [state.plans]);
  const stationName = (id: string) => state.stations.find((s) => s.id === id)?.name ?? id;
  const allocated = allocatedVehicles(state.plans);
  const affectedCount = viewStations.filter((s) => s.status !== "正常").length;
  const queuedCount = state.plans.filter((p) => p.status === "排队").length;
  const activeConflicts = state.conflicts.filter((c) => !c.resolved).length;

  const stationColumns: ColumnsType<ViewStation> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "对外状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={statusColor[value]}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    {
      title: "处置", render: (_, record) => (
        <Space>
          <Button size="small" disabled={state.role === "客服主管"} onClick={() => run(state.reportStationStatus(record.id, "限流"), "已上报限流，车站状态按事件重算")}>限流</Button>
          <Button size="small" danger disabled={state.role === "客服主管"} onClick={() => run(state.reportStationStatus(record.id, "封闭"), "已上报封闭，车站状态按事件重算")}>封闭</Button>
          <Button size="small" disabled={state.role === "客服主管"} onClick={() => run(state.reportStationStatus(record.id, "恢复中"), "已上报恢复中")}>恢复</Button>
        </Space>
      )
    }
  ];

  const submitPlan = (values: PlanForm) => {
    const parsed = planSchema.safeParse(values);
    if (!parsed.success) return;
    state.addPlan(parsed.data);
    setModalOpen(false);
    reset();
    messageApi.success("计划已保存为草稿");
  };

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") },
    {
      title: "车辆", dataIndex: "vehicles", sorter: (a, b) => a.vehicles - b.vehicles,
      render: (v: number, record) => (
        <Space>
          <b>{v}</b>
          {record.allocated ? <Tag color="blue">已占用</Tag> : <Tag>{record.status === "排队" ? "排队中" : "未占用"}</Tag>}
        </Space>
      )
    },
    { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
    { title: "运营方", dataIndex: "operator" },
    {
      title: "跨岗位确认", dataIndex: "approvals",
      render: (_: string[], record) => (
        <Space size={4} wrap>
          {record.requiredRoles.map((role) => {
            const approved = record.approvals.includes(role);
            return <Tag key={role} color={approved ? "green" : "default"}>{role}{approved ? " ✓" : " 待确认"}</Tag>;
          })}
        </Space>
      )
    },
    { title: "状态", dataIndex: "status", render: (v) => <Tag color={v === "已确认" || v === "已执行" ? "green" : v === "待确认" ? "orange" : v === "排队" ? "gold" : v === "已完成" ? "default" : "blue"}>{v}</Tag> },
    {
      title: "操作", render: (_, record) => (
        <Space size={4} wrap>
          {record.status === "草稿" && <Button size="small" type="primary" onClick={() => run(state.submitPlan(record.id), "已提交：占用车辆或进入排队")}>提交确认</Button>}
          {["草稿", "待确认", "已确认"].includes(record.status) && (
            <Button size="small" onClick={() => { setEditTarget(record); setEditVehicles(record.vehicles); }}>改车辆</Button>
          )}
          {record.status === "待确认" && <Button size="small" disabled={state.role === "客服主管"} onClick={() => run(state.approvePlan(record.id, state.role))}>确认</Button>}
          {record.status === "已确认" && <Button size="small" type="primary" onClick={() => run(state.executePlan(record.id), "计划已下发执行")}>执行</Button>}
          {record.status === "已执行" && <Button size="small" onClick={() => run(state.completePlan(record.id), "计划完成，车辆已释放")}>完成释放</Button>}
        </Space>
      )
    }
  ];

  const eventColumns: ColumnsType<Event> = [
    { title: "事件", dataIndex: "title" },
    { title: "区段", dataIndex: "section" },
    { title: "严重度", dataIndex: "severity", render: (v: StationStatus) => <Tag color={statusColor[v]}>{v}</Tag> },
    { title: "覆盖车站", dataIndex: "stationIds", render: (ids: string[]) => ids.map(stationName).join("、") },
    { title: "状态", dataIndex: "status", render: (v) => <Tag color={v === "进行中" ? "red" : "default"}>{v}</Tag> },
    { title: "上报人", dataIndex: "reportedBy" },
    { title: "开始", dataIndex: "startedAt", render: (v: string) => format(new Date(v), "HH:mm") },
    {
      title: "操作", render: (_, record) => (
        <Button size="small" danger disabled={record.status !== "进行中" || state.role === "客服主管"} onClick={() => run(state.closeEvent(record.id), "事件已收束，车站状态已重算")}>收束</Button>
      )
    }
  ];

  const statementColumns: ColumnsType<Statement> = [
    { title: "口径内容", dataIndex: "content" },
    { title: "发布人", dataIndex: "publishedBy" },
    { title: "发布时间", dataIndex: "publishedAt", render: (v: string) => format(new Date(v), "MM-dd HH:mm") },
    {
      title: "状态", dataIndex: "status",
      render: (v, record) => <Tag color={v === "有效" ? "green" : "default"}>{v}{record.invalidReason ? `：${record.invalidReason}` : ""}</Tag>
    }
  ];

  return (
    <div className="shell">
      {contextHolder}
      <aside className="side">
        <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
        <nav>{["总览", "事件时间线", "接驳计划", "确认中心", "口径管理"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
        <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
      </aside>
      <main>
        <header>
          <div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div>
          <Space>
            <Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} />
            <Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} />
          </Space>
        </header>

        <section className="metrics">
          <Card><Statistic title="事件状态" value={state.incident.status} /></Card>
          <Card><Statistic title="受影响车站" value={affectedCount} suffix="座" /></Card>
          <Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认").length} /></Card>
          <Card><Statistic title="车辆池占用" value={allocated} suffix={`/ ${VEHICLE_POOL_CAPACITY} 辆`} /></Card>
          <Card><Statistic title="排队计划" value={queuedCount} /></Card>
          <Card><Statistic title="待同步操作" value={state.pendingActions.length} /></Card>
        </section>

        {!state.online && <div className="degrade">当前处于弱网降级模式：处置先记入本地队列，恢复后按事件和车站合并；车辆重复占用会保留为冲突。</div>}
        {activeConflicts > 0 && <Alert className="conflict-alert" type="error" showIcon message={`存在 ${activeConflicts} 条车辆占用冲突`} description="本地队列合并后同一辆车被多条计划同时占用，请在确认中心处理。" />}

        {panel === "总览" && (
          <section className="overview">
            <Card title="车站状态（按未结束事件最严重一条推导）" className="wide">
              <Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations.map((s) => ({ ...s, status: deriveStationStatus(state.events, s.id) })) : viewStations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 820 }} />
            </Card>
            <Card title="受影响区段" className="map-card"><MapPanel stations={viewStations} plans={mapPlans} /></Card>
            <Card title="事件台账" className="wide"><Table rowKey="id" dataSource={state.events} columns={eventColumns} pagination={false} size="small" /></Card>
          </section>
        )}

        {panel === "事件时间线" && (
          <Card title="处置时间线" extra={<Space><Select value="响应" options={[{ value: "响应" }, { value: "接驳" }, { value: "恢复" }]} /><Button type="primary" onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}>
            <div className="timeline-grid">
              <Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-dd HH:mm:ss")} · {item.phase}</small></div> }))} />
              <Card size="small" title="处置检查">
                <p>车站对外状态由未结束事件中最严重的一条决定，事件收束后立即重算。</p>
                <p>接驳车辆为共享资源，池子见底时新计划排队；确认需调度员与公交负责人双方。</p>
                <p>恢复行车前检查区间水位和站台安全。</p>
              </Card>
            </div>
          </Card>
        )}

        {panel === "接驳计划" && (
          <Card
            title={`公交接驳计划（车辆池 ${allocated}/${VEHICLE_POOL_CAPACITY}，空闲 ${VEHICLE_POOL_CAPACITY - allocated}）`}
            extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}
          >
            <Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} size="small" />
          </Card>
        )}

        {panel === "确认中心" && (
          <Card title="跨岗位确认中心">
            {state.conflicts.length > 0 && (
              <div className="conflict-block">
                <h4>车辆占用冲突</h4>
                {state.conflicts.map((conflict) => (
                  <Alert
                    key={conflict.id}
                    className="conflict-item"
                    type={conflict.resolved ? "success" : "error"}
                    showIcon
                    message={conflict.detail}
                    description={
                      <Space>
                        <span>涉及计划：{conflict.planIds.map((id) => id.slice(0, 6)).join("、")}</span>
                        {!conflict.resolved && <Button size="small" onClick={() => state.resolveConflict(conflict.id)}>标记已处理</Button>}
                      </Space>
                    }
                  />
                ))}
              </div>
            )}
            <Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag color={plan.status === "已确认" ? "green" : "orange"}>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>已确认：{plan.approvals.join("、") || "暂无"} · 待：{plan.requiredRoles.filter((r) => !plan.approvals.includes(r)).join("、") || "无"}</small></div> }))} />
            <Button disabled={state.online || !state.pendingActions.length} onClick={state.syncActions}>网络恢复，合并本地队列（{state.pendingActions.length} 条）</Button>
          </Card>
        )}

        {panel === "口径管理" && (
          <Card title="对外口径">
            {state.role === "客服主管" ? (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input.TextArea rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="发布对外口径，例如：受区间积水影响，滨江站临时封闭，请乘客改乘公交接驳……" />
                <Button type="primary" onClick={() => { const r = state.publishStatement(statement); if (r.ok) { setStatement(""); messageApi.success("口径已发布"); } else messageApi.error(r.error ?? "发布失败"); }}>发布口径</Button>
              </Space>
            ) : (
              <Alert type="info" showIcon message="对外口径由客服主管统一发布" description="车站状态或接驳车辆数变动后，已发布口径会自动失效，需客服主管重新发布。" />
            )}
            <Table style={{ marginTop: 16 }} rowKey="id" pagination={false} dataSource={state.statements} columns={statementColumns} size="small" locale={{ emptyText: "暂无口径" }} />
          </Card>
        )}
      </main>

      <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿">
        <Form layout="vertical">
          <Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}>
            <Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} />
          </Form.Item>
          <Space>
            <Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} max={VEHICLE_POOL_CAPACITY} />} /></Form.Item>
            <Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item>
          </Space>
          <Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="调整接驳车辆数"
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={() => { if (editTarget) { const r = state.updatePlanVehicles(editTarget.id, editVehicles); if (r.ok) { setEditTarget(null); messageApi.success("车辆数已重新分配"); } else messageApi.error(r.error ?? "调整失败"); } }}
        okText="重新分配"
      >
        <p>计划 {editTarget?.id.slice(0, 6)}（{editTarget?.stations.join(" → ")}）当前 {editTarget?.vehicles} 辆。调整将退回原占用并重新分配，已确认计划需重新确认。</p>
        <InputNumber min={1} max={VEHICLE_POOL_CAPACITY} value={editVehicles} onChange={(v) => setEditVehicles(Number(v) || 1)} addonAfter="辆" style={{ width: "100%" }} />
      </Modal>
    </div>
  );
}

export default function Page() {
  return <AntApp><Dashboard /></AntApp>;
}
