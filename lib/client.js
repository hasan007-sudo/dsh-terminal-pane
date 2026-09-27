window.__ModuleLoader__.load({
  id: "dsh-terminal-pane",
  factory(require) {
    const React = require("react");
    const { useCallback, useEffect, useRef, useState } = React;

    const CHANNEL = "/rpc/terminal";
    const STYLE_ID = "dsh-terminal-pane-style";
    const NS = "dsh-terminal-pane";

    const en = {
      title: "Terminal",
      hint: "Enter runs · Ctrl+C interrupts",
      placeholder: "Type a command and press Enter",
      starting: "starting shell…",
      busy: "running…",
      ready: "",
      error: "error",
    };

    const CSS = `
      .dtp-root { display: flex; flex-direction: column; border: 1px solid var(--dsh-border, rgba(127,127,127,.28)); border-radius: 10px; overflow: hidden; margin: 8px auto; max-width: 1100px; background: rgba(0,0,0,.04); }
      .dtp-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; user-select: none; font-size: 12px; opacity: .85; }
      .dtp-bar:hover { opacity: 1; }
      .dtp-title { font-weight: 600; }
      .dtp-spacer { flex: 1; }
      .dtp-hint { font-size: 11px; opacity: .6; }
      .dtp-out { margin: 0; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; overflow: auto; height: 280px; background: rgba(0,0,0,.55); color: #e6e6e6; }
      .dtp-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--dsh-border, rgba(127,127,127,.28)); }
      .dtp-prompt { font-family: ui-monospace, monospace; font-size: 13px; opacity: .7; }
      .dtp-input { flex: 1; border: 0; outline: 0; background: transparent; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color: inherit; padding: 4px 0; }
      .dtp-status { font-size: 11px; opacity: .6; white-space: nowrap; }
      .dtp-status-error { color: #e5534b; opacity: 1; }
    `;

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /** PTY output uses CRLF; a <pre> renders a bare CR as a cursor jump. */
    function normalize(text) {
      return String(text ?? "").replace(/\r/g, "");
    }

    function TerminalPane(props) {
      const ctx = props.ctx;
      const tr = (key) => (ctx.locale && typeof ctx.locale.tr === "function" ? ctx.locale.tr(NS, key) : en[key]) || en[key];

      const [open, setOpen] = useState(false);
      const [text, setText] = useState("");
      const [output, setOutput] = useState("");
      const [status, setStatus] = useState("idle");
      const [error, setError] = useState(null);
      const keyRef = useRef(null);
      const outRef = useRef(null);
      const inputRef = useRef(null);

      const call = useCallback(
        async (endpoint, payload) => {
          const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload);
          if (!result || result.ok !== true) {
            const message = result && result.error ? result.error.message : "terminal rpc failed";
            throw new Error(message);
          }
          return result.value;
        },
        [ctx],
      );

      // Spawn the shell on first expand, never on page load.
      useEffect(() => {
        if (!open || keyRef.current) return;
        const key = (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random()}`);
        keyRef.current = key;
        setStatus("starting");
        setError(null);
        call("open", { key })
          .then((value) => {
            setOutput(normalize(value.text));
            setStatus("idle");
          })
          .catch((cause) => {
            keyRef.current = null;
            setError(cause.message);
            setStatus("error");
          });
      }, [open, call]);

      // Release the shell when the pane goes away.
      useEffect(() => {
        return () => {
          const key = keyRef.current;
          if (key) void call("close", { key }).catch(() => {});
        };
      }, [call]);

      useEffect(() => {
        const node = outRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [output]);

      const run = useCallback(async () => {
        const key = keyRef.current;
        const line = text;
        if (!key || !line.trim()) return;
        setText("");
        setStatus("busy");
        setError(null);
        try {
          const value = await call("send", { key, text: line, submit: true });
          setOutput(normalize(value.text));
          setStatus("idle");
        } catch (cause) {
          setError(cause.message);
          setStatus("error");
        }
      }, [call, text]);

      const interrupt = useCallback(async () => {
        const key = keyRef.current;
        if (!key) return;
        setStatus("busy");
        try {
          const value = await call("interrupt", { key });
          setOutput(normalize(value.text));
          setStatus("idle");
        } catch (cause) {
          setError(cause.message);
          setStatus("error");
        }
      }, [call]);

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void run();
          } else if (event.ctrlKey && (event.key === "c" || event.key === "C")) {
            event.preventDefault();
            void interrupt();
          }
        },
        [run, interrupt],
      );

      const toggle = useCallback(() => {
        setOpen((value) => !value);
        if (!open) setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
      }, [open]);

      const statusText = error
        ? `${tr("error")}: ${error}`
        : status === "starting"
          ? tr("starting")
          : status === "busy"
            ? tr("busy")
            : tr("ready");

      return React.createElement(
        "div",
        { className: "dtp-root" },
        React.createElement(
          "div",
          { className: "dtp-bar", onClick: toggle, role: "button", tabIndex: 0, "aria-expanded": open },
          React.createElement("span", { className: "dtp-title" }, open ? "▾" : "▸", " ", tr("title")),
          React.createElement("span", { className: "dtp-spacer" }),
          open ? React.createElement("span", { className: "dtp-hint" }, tr("hint")) : null,
        ),
        open
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement("pre", { className: "dtp-out", ref: outRef }, output),
              React.createElement(
                "div",
                { className: "dtp-row" },
                React.createElement("span", { className: "dtp-prompt" }, "$"),
                React.createElement("input", {
                  className: "dtp-input",
                  ref: inputRef,
                  value: text,
                  placeholder: tr("placeholder"),
                  spellCheck: false,
                  autoComplete: "off",
                  onChange: (event) => setText(event.target.value),
                  onKeyDown,
                }),
                React.createElement(
                  "span",
                  { className: error ? "dtp-status dtp-status-error" : "dtp-status" },
                  statusText,
                ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ["connection", "slots"],
      apply(ctx) {
        installStyle();
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { en, zh: en });
        }
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "terminal-pane",
              order: 10,
            },
            (props) => React.createElement(TerminalPane, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
