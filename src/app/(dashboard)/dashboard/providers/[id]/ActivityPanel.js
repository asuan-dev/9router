"use client";

import { useState, useRef, useEffect } from "react";

/**
 * ActivityPanel — dropdown panel for account activities (check-in etc.)
 * Shown as an icon button on the connection row; opens a small panel.
 *
 * Props:
 *   connection — the connection object
 *   providerId — provider id string
 *   onStateUpdate — callback(patch) to update connection.providerSpecificData in parent
 */
export default function ActivityPanel({ connection, providerId, onStateUpdate }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const ref = useRef(null);

  const psd = connection.providerSpecificData || {};
  const autoEnabled = psd.autoCheckinEnabled === true;
  const lastResult = psd.autoCheckinLastResult || null;
  const lastMessage = psd.autoCheckinLastMessage || "";
  const lastCredit = psd.autoCheckinLastCredit;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function callApi(action) {
    setBusy(true);
    setStatusMsg("");
    try {
      const res = await fetch("/api/activities/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (action === "enable" || action === "disable") {
        if (data.ok && onStateUpdate) {
          onStateUpdate({ autoCheckinEnabled: data.autoCheckinEnabled });
        }
        setStatusMsg(data.ok ? (data.autoCheckinEnabled ? "自动签到已开启" : "自动签到已关闭") : (data.message || "操作失败"));
      } else {
        setStatusMsg(data.ok ? (data.message || "ok") : (data.message || data.error || "失败"));
        // Update local state from result
        if (data.ok && onStateUpdate) {
          onStateUpdate({
            autoCheckinLastResult: data.already ? "already" : "success",
            autoCheckinLastMessage: data.message || "",
            autoCheckinLastAt: new Date().toISOString(),
            autoCheckinLastCredit: data.credits ?? null,
          });
        }
      }
    } catch (e) {
      setStatusMsg(e.message || "网络错误");
    } finally {
      setBusy(false);
    }
  }

  // Status indicator
  const statusIcon = lastResult === "success" || lastResult === "already"
    ? "check_circle"
    : lastResult === "fail"
      ? "error"
      : "radio_button_unchecked";
  const statusColor = lastResult === "success" || lastResult === "already"
    ? "text-green-500"
    : lastResult === "fail"
      ? "text-red-500"
      : "text-text-muted";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoEnabled || lastResult ? "text-primary" : "text-text-muted hover:text-primary"}`}
        title="账号活动"
      >
        <span className="material-symbols-outlined text-[18px]">redeem</span>
        <span className="text-[10px] leading-tight">活动</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[240px] rounded-lg border border-border bg-bg p-3 shadow-lg">
          <div className="text-xs font-medium mb-2 text-text-main">每日签到</div>

          {/* Auto toggle row */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-text-muted">自动签到</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => callApi(autoEnabled ? "disable" : "enable")}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoEnabled ? "bg-primary" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${autoEnabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
            </button>
          </div>

          {/* Status row */}
          <div className="flex items-center gap-1.5 mb-2">
            <span className={`material-symbols-outlined text-[14px] ${statusColor}`}>{statusIcon}</span>
            <span className="text-xs text-text-muted truncate">
              {lastMessage || "暂无记录"}
              {lastCredit != null ? ` (+${lastCredit})` : ""}
            </span>
          </div>

          {/* Manual claim button */}
          <button
            type="button"
            disabled={busy}
            onClick={() => callApi("claim")}
            className="w-full rounded border border-border px-2 py-1.5 text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
          >
            {busy ? "处理中..." : "立即签到"}
          </button>

          {/* Result message */}
          {statusMsg && (
            <div className="mt-2 text-[11px] text-text-muted border-t border-border pt-1.5">{statusMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}
