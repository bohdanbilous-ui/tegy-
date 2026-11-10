"use client";
import React, { useState } from "react";

/* Згорнуте пояснення: у рядку лише «ⓘ Як це працює», текст — за кліком. */
export default function Info({ title = "Як це працює", children, style }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "8px 0 0", ...style }}>
      <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ fontSize: 12.5, color: "#64748B", textDecoration: "none" }}>
        ⓘ {title} {open ? "▴" : "▾"}
      </button>
      {open && <div style={{ margin: "8px 0 0", color: "#64748B", fontSize: 12.5, lineHeight: 1.55, maxWidth: 780 }}>{children}</div>}
    </div>
  );
}
