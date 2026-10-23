import { useState, useSyncExternalStore } from "react";
import { DatePicker, Select, Space, Typography } from "antd";
import dayjs from "dayjs";
import { rangeInstants, rangePreset, type DateRange } from "./date-range";

// Shared while navigating this console; no private data in browser storage.
let selected = rangePreset("today");
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const setSelected = (next: DateRange) => {
  if (!rangeInstants(next) || (next.start === selected.start && next.end === selected.end)) return;
  selected = next;
  listeners.forEach(listener => listener());
};
export function useAdminRange(): [DateRange, (next: DateRange) => void] {
  return [useSyncExternalStore(subscribe, () => selected), setSelected];
}

export function DateRangeFilter({ value, onChange }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [error, setError] = useState(false);
  return (
    <Space wrap>
      <Select<string>
        aria-label="快捷时间范围"
        placeholder="快捷范围"
        value={undefined}
        style={{ width: 120 }}
        onChange={key => { setError(false); onChange(rangePreset(key)); }}
        options={[
          { value: "today", label: "今天" },
          { value: "yesterday", label: "昨天" },
          { value: "7", label: "最近7天" },
          { value: "30", label: "最近30天" },
          { value: "month", label: "本月" },
          { value: "previousMonth", label: "上月" }
        ]}
      />
      <DatePicker.RangePicker
        aria-label="北京时间起止日期"
        allowClear={false}
        value={[dayjs(value.start), dayjs(value.end)]}
        onChange={dates => {
          if (!dates?.[0] || !dates[1]) return;
          const next = { start: dates[0].format("YYYY-MM-DD"), end: dates[1].format("YYYY-MM-DD") };
          if (!rangeInstants(next)) { setError(true); return; }
          setError(false);
          onChange(next);
        }}
      />
      <Typography.Text type={error ? "danger" : "secondary"}>
        {error ? "每次最多查询366天，请缩小区间。" : "北京时间 · 含起止日期"}
      </Typography.Text>
    </Space>
  );
}
