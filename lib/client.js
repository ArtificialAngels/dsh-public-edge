window.__ModuleLoader__.load({
	id: "dsh-public-edge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useState, useEffect, useCallback } = react;

		const STATE_PATH = "api/dsh-public-edge/state";
		const CONTROL_PATH = "api/dsh-public-edge/control";

		const C = {
			fg: "currentColor",
			dim: "#94a3b8",
			line: "rgba(148,163,184,.25)",
			card: "rgba(148,163,184,.08)",
			accent: "#4d6bfe",
			ok: "#34d399",
			err: "#f87171",
			warn: "#fbbf24",
		};

		function urlOf(path) {
			try {
				return new URL(path, document.baseURI).href;
			} catch (_) {
				return "/" + path;
			}
		}

		async function fetchState() {
			const response = await fetch(urlOf(STATE_PATH), { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		}

		async function sendOp(op) {
			const response = await fetch(urlOf(CONTROL_PATH), {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data && data.error ? data.error : "HTTP " + response.status);
			return data;
		}

		function Dot(props) {
			return jsx("span", {
				style: {
					display: "inline-block",
					width: 8,
					height: 8,
					borderRadius: "50%",
					marginRight: 6,
					background: props.color,
					boxShadow: "0 0 8px " + props.color,
				},
			});
		}

		function Button(props) {
			return jsx("button", {
				onClick: props.onClick,
				disabled: props.disabled === true,
				style: {
					border: "1px solid " + (props.primary ? C.accent : C.line),
					background: props.primary ? C.accent : "transparent",
					color: props.primary ? "#fff" : "inherit",
					borderRadius: 8,
					padding: "6px 12px",
					fontSize: 12,
					cursor: props.disabled ? "default" : "pointer",
					opacity: props.disabled ? 0.55 : 1,
				},
				children: props.children,
			});
		}

		function PublicEdgeSection(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [copied, setCopied] = useState(false);
			const [showQr, setShowQr] = useState(false);

			const refresh = useCallback(async () => {
				try {
					const next = await fetchState();
					setState(next);
					setError(next && next.error ? next.error : "");
				} catch (e) {
					setError(String((e && e.message) || e));
				}
			}, []);

			useEffect(() => {
				let alive = true;
				const tick = async () => {
					if (!alive) return;
					await refresh();
				};
				tick();
				const timer = setInterval(tick, 4000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [refresh]);

			const run = async (op) => {
				setBusy(true);
				setError("");
				try {
					const next = await sendOp(op);
					setState(next);
				} catch (e) {
					setError(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			};

			const copyLink = async () => {
				const link = state && state.link;
				if (!link) return;
				try {
					await navigator.clipboard.writeText(link);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch (e) {
					setError("复制失败：" + String((e && e.message) || e));
				}
			};

			const running = Boolean(state && state.running);
			const starting = Boolean(state && state.starting);
			const link = state && state.link ? state.link : "";
			const tunnelUrl = state && state.tunnelUrl ? state.tunnelUrl : "";
			const statusText = starting ? "启动中…" : running ? (tunnelUrl ? "运行中" : "桥已就绪，等待隧道地址") : "已停止";
			const statusColor = starting ? C.warn : running ? C.ok : C.dim;

			const row = (label, value) =>
				jsxs("div", {
					style: { display: "flex", gap: 10, alignItems: "baseline", fontSize: 12, lineHeight: 1.6 },
					children: [
						jsx("span", { style: { color: C.dim, minWidth: 64, flex: "0 0 auto" }, children: label }),
						jsx("span", { style: { wordBreak: "break-all", color: C.fg }, children: value }),
					],
				});

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 12, fontSize: 13 },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
						children: [
							jsx(Dot, { color: statusColor }),
							jsx("span", { style: { fontWeight: 600 }, children: statusText }),
							jsx("span", { style: { color: C.dim }, children: "· 端口 " + String((state && state.bridgePort) || 8787) }),
							jsx("span", { style: { flex: "1 1 auto" } }),
							jsx(Button, { onClick: () => run("start"), disabled: busy || running || starting, primary: true, children: "启动" }),
							jsx(Button, { onClick: () => run("stop"), disabled: busy || (!running && !starting), children: "停止" }),
							jsx(Button, { onClick: () => run("restart"), disabled: busy || !running, children: "换地址" }),
						],
					}),
					jsxs("div", {
						style: { background: C.card, border: "1px solid " + C.line, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
						children: [
							row("状态", running ? "公网可访问（Cloudflare 隧道）" : "未开启公网访问"),
							row("隧道", tunnelUrl || "—"),
							jsxs("div", {
								style: { display: "flex", gap: 10, alignItems: "flex-start" },
								children: [
									jsx("span", { style: { color: C.dim, minWidth: 64, flex: "0 0 auto", paddingTop: 2, fontSize: 12 }, children: "链接" }),
									jsx("code", {
										style: { flex: "1 1 auto", wordBreak: "break-all", fontSize: 12, background: "rgba(0,0,0,.18)", borderRadius: 6, padding: "4px 8px", color: link ? C.fg : C.dim },
										children: link || "启动后会生成带 token 的公网链接",
									}),
								],
							}),
							jsxs("div", {
								style: { display: "flex", gap: 8, flexWrap: "wrap" },
								children: [
									jsx(Button, { onClick: copyLink, disabled: !link, primary: true, children: copied ? "已复制" : "复制链接" }),
									jsx(Button, { onClick: () => setShowQr(!showQr), disabled: !link, children: showQr ? "隐藏二维码" : "显示二维码" }),
									jsx(Button, { onClick: refresh, disabled: busy, children: "刷新" }),
								],
							}),
						],
					}),
					showQr && state && state.qrSvg
						? jsx("div", { style: { display: "flex", justifyContent: "center", background: "#fff", borderRadius: 10, padding: 10, alignSelf: "flex-start" }, dangerouslySetInnerHTML: { __html: state.qrSvg } })
						: null,
					error
						? jsx("div", { style: { color: C.err, fontSize: 12, lineHeight: 1.6 }, children: error })
						: null,
					state && state.pairUrl
						? jsx("div", { style: { color: C.dim, fontSize: 11, lineHeight: 1.7 }, children: "本机二维码页（只有本机能打开）：" + state.pairUrl })
						: null,
					jsx("div", { style: { color: C.dim, fontSize: 11, lineHeight: 1.7 }, children: "启动后公网链接、二维码由本机隧道生成；链接含登录令牌，等同本机控制权，请勿外传。公网地址在隧道重启后会变，届时点「换地址」或重启 DSH。未安装 cloudflared 时首次启动会自动下载（国内网络可走镜像）。" }),
				],
			});
		}

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (!slots || typeof slots.inject !== "function") return;
			slots.inject("settings.section", () =>
				slots.register(
					{
						name: "settings.section",
						id: "dsh-public-edge",
						order: 46,
						label: () => "公网访问",
						inject: () => ({ t: (key) => key }),
					},
					PublicEdgeSection,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
