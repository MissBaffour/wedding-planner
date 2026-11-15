import { render } from 'preact';
import { WidgetApi } from './api.ts';
import { App } from './App.tsx';

/**
 * Embed:
 *   <script src="https://cdn.example/widget.js" data-kasadesk-key="wc_..." data-kasadesk-api="https://api.example" async></script>
 * Renders inside a Shadow DOM so the host page's CSS cannot break the widget (and vice versa).
 */
(function boot() {
  const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-kasadesk-key]');
  const key = script?.dataset.kasadeskKey;
  const api = script?.dataset.kasadeskApi ?? (script ? new URL(script.src).origin : '');
  if (!key || !api || document.getElementById('kasadesk-widget')) return;
  const start = () => {
    const host = document.createElement('div');
    host.id = 'kasadesk-widget';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    render(<App api={new WidgetApi(api.replace(/\/$/, ''), key)} storageKey={`kd_wc_${key}`} />, root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
