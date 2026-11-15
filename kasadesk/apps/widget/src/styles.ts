export const css = (color: string) => `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.launcher{position:fixed;right:16px;bottom:16px;width:56px;height:56px;border-radius:50%;border:0;background:${color};color:#fff;
  box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;z-index:2147483000;display:flex;align-items:center;justify-content:center}
.launcher svg{width:26px;height:26px}
.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;
  line-height:20px;padding:0 5px;text-align:center}
.panel{position:fixed;right:16px;bottom:84px;width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 110px);
  background:#fff;color:#111827;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000}
@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}}
.head{background:${color};color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}
.head h2{margin:0;font-size:16px;font-weight:600}.head p{margin:2px 0 0;font-size:12px;opacity:.9}
.x{background:transparent;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px}
.list{flex:1;overflow-y:auto;padding:12px;background:#f3f4f6;display:flex;flex-direction:column;gap:6px}
.msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}
.business{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}
.visitor{align-self:flex-end;background:${color};color:#fff}
.meta{font-size:11px;opacity:.7;margin-top:2px}
.pending{opacity:.6}
.form{padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff;font-size:13px}
.form input[type=text],.form input[type=tel]{width:100%;padding:8px;margin:4px 0;border:1px solid #d1d5db;border-radius:8px;font-size:14px}
.form label{display:flex;gap:6px;align-items:flex-start;margin:6px 0;font-size:12px;color:#374151}
.form a{color:${color}}
.row{display:flex;gap:6px}.btn{background:${color};color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:14px}
.btn.secondary{background:#e5e7eb;color:#111827}
.compose{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}
.compose textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px;font-size:14px;max-height:96px}
.offline{background:#fef3c7;color:#92400e;font-size:12px;padding:6px 12px;text-align:center}
.err{color:#b91c1c;font-size:12px}
`;
