import { useEffect, useRef, useState } from "react";
import { getNotifications, type Notification } from "../api";

const DOT: Record<Notification["severity"], string> = {
  info: "#7c8aff",
  success: "#3fd07a",
  warning: "#f5b73d",
  critical: "#ff5b5b",
};

/** Header notification bell — protocol alerts derived from the event stream. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => getNotifications().then(setItems).catch(() => setItems([]));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const unseen = items.filter((n) => n.severity === "critical" || n.severity === "warning").length;

  return (
    <div className="bell" ref={ref} style={{ position: "relative" }}>
      <button className="tab" onClick={() => setOpen((o) => !o)} title="Notifications">
        🔔 {items.length}
        {unseen > 0 && <span className="bell-badge">{unseen}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          {items.length === 0 && <div className="muted" style={{ padding: 12 }}>No notifications.</div>}
          {items.map((n) => (
            <div key={n.id} className="bell-item">
              <span className="bell-dot" style={{ background: DOT[n.severity] }} />
              <div>
                <strong>{n.title}</strong>
                <div className="muted">{n.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
