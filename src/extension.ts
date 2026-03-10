import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';

// ══════════════════════════════════════════════════════════════════
// AG Super Auto-Accept v4.0 — Ultimate 3-Layer Architecture
//
// Layer 1: gRPC to AG language server (terminal accepts)
// Layer 2: CDP WebSocket DOM injection (agent panel clicks)
// Layer 3: VS Code commands fallback (edge cases)
//
// Event-driven state machine: IDLE → FAST → SLOW → IDLE
// ══════════════════════════════════════════════════════════════════

const execAsync = promisify(exec);

// ─── State Machine ────────────────────────────────────────────────
enum State { IDLE = 'IDLE', FAST = 'FAST', SLOW = 'SLOW' }

let out: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let godModeBar: vscode.StatusBarItem;
let state = State.IDLE;
let enabled = true;
let godMode = false;
let busy = false;          // async lock
let logLines = 0;
let windowFocused = true;
let lastTickTime = Date.now();

// Timers
let pollTimer: ReturnType<typeof setInterval> | undefined;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let sleepTimer: ReturnType<typeof setInterval> | undefined;
let textChangeTimer: ReturnType<typeof setTimeout> | undefined;
let events: vscode.Disposable[] = [];

// CDP — persistent connections like mstrvn
const CDP_PORTS = [9222, 9229, ...Array.from({ length: 7 }, (_, i) => 8997 + i)];
let cdpPortFound: number | null = null;
let cdpConnections: Map<string, { ws: WebSocket; id: string; injected: boolean; connectedAt: number }> = new Map();
const CDP_MAX_AGE_MS = 600_000; // 10 minutes — force reconnect after this
let cdpMsgId = 1;
let cdpReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cdpFailCount = 0;
let cdpRestartPrompted = false;
let cdpNotifyCount = 0;
const CDP_MAX_NOTIFY = 3;

// gRPC server cache
let grpcServer: { port: number; csrfToken: string; useHttps: boolean } | null = null;
let grpcCacheTime = 0;

// Config
let cfg = {
    fastMs: 500,
    slowMs: 3000,
    heartbeatMs: 8000,
    fastDuration: 10000,
    cooldownDuration: 30000,
    cdpPort: 9222,
    enableCDP: true,
    debugMode: false,
};

// VS Code accept commands (Layer 3 fallback)
const ACCEPT_CMDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
] as const;

// ══════════════════════════════════════════════════════════════════
// Activation
// ══════════════════════════════════════════════════════════════════

export function activate(ctx: vscode.ExtensionContext) {
    try {
        out = vscode.window.createOutputChannel('AG Super Auto-Accept');
        log('v4.3.2 activated');
        loadConfig();

        // Status bars
        statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
        statusBar.command = 'agSuper.toggle';
        ctx.subscriptions.push(statusBar);

        godModeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
        godModeBar.command = 'agSuper.toggleGodMode';
        ctx.subscriptions.push(godModeBar);

        // Restore states
        enabled = ctx.globalState.get('agSuperEnabled', true);
        godMode = ctx.globalState.get('agSuperGodMode', false);
        updateStatusBar();
        updateGodModeBar();
        statusBar.show();
        godModeBar.show();

        // Commands
        ctx.subscriptions.push(
            vscode.commands.registerCommand('agSuper.toggle', () => {
                enabled = !enabled;
                ctx.globalState.update('agSuperEnabled', enabled);
                if (enabled) {
                    registerEvents();
                    startHeartbeat();
                    transitionTo(State.FAST, 'toggle');
                    vscode.window.showInformationMessage('AG Auto-Accept: ON ✅');
                } else {
                    clearAll();
                    disposeEvents();
                    cdpDisconnect();
                    state = State.IDLE;
                    vscode.window.showInformationMessage('AG Auto-Accept: OFF 🛑');
                }
                updateStatusBar();
            }),
            vscode.commands.registerCommand('agSuper.toggleGodMode', () => {
                godMode = !godMode;
                ctx.globalState.update('agSuperGodMode', godMode);
                updateGodModeBar();
                vscode.window.showInformationMessage(
                    godMode ? '⚠️ God Mode ON — folder access auto-allowed' : '🛡️ God Mode OFF'
                );
            }),
            vscode.commands.registerCommand('agSuper.forceAccept', async () => {
                log('Force accept triggered');
                await tryAcceptAll();
                vscode.window.showInformationMessage('Force accept executed');
            }),
            vscode.commands.registerCommand('agSuper.showLog', () => out.show())
        );

        // Config change
        ctx.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('agAutoAccept')) {
                    loadConfig();
                    if (enabled) startHeartbeat();
                }
            })
        );

        // Auto-start
        if (enabled) {
            registerEvents();
            startHeartbeat();
            startSleepDetection();
            // Delayed start: give AG time to register commands
            setTimeout(() => {
                verifyCommands();
                transitionTo(State.FAST, 'activate');
            }, 3000);

            // Auto-setup CDP (best-effort, never crash on failure)
            if (cfg.enableCDP) {
                try { ensureDebugPort(); } catch (e: any) {
                    log(`[CDP] ensureDebugPort failed: ${e?.message}`);
                }
                // Periodic health check: force re-discover every 90 seconds
                // Catches silently dead WebSockets, account switches, port changes
                setInterval(() => {
                    if (enabled) {
                        invalidateCaches('periodicHealth');
                        if (state === State.IDLE) transitionTo(State.FAST, 'healthCheck');
                    }
                }, 90_000);
            }
        }

        log('Ready');
    } catch (e: any) {
        // Last resort: if activation itself crashes, log to console so it shows in Extension Host log
        const msg = `GravityPilot activation error: ${e?.message || e}`;
        console.error(msg, e);
        try { out?.appendLine(msg); } catch { }
        // Still try to show status bar so user knows something went wrong
        try {
            if (statusBar) {
                statusBar.text = '$(error) AG: ERROR';
                statusBar.tooltip = msg;
                statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                statusBar.show();
            }
        } catch { }
    }
}

// ══════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════

function loadConfig() {
    const c = vscode.workspace.getConfiguration('agAutoAccept');
    cfg = {
        fastMs: Math.max(c.get<number>('fastIntervalMs', 500), 200),
        slowMs: Math.max(c.get<number>('slowIntervalMs', 3000), 1000),
        heartbeatMs: Math.max(c.get<number>('heartbeatIntervalMs', 8000), 3000),
        fastDuration: c.get<number>('fastDurationMs', 10000),
        cooldownDuration: c.get<number>('cooldownDurationMs', 30000),
        cdpPort: c.get<number>('cdpPort', 9222),
        enableCDP: c.get<boolean>('enableCDP', true),
        debugMode: c.get<boolean>('debugMode', false),
    };
}

// ══════════════════════════════════════════════════════════════════
// State Machine
// ══════════════════════════════════════════════════════════════════

function transitionTo(newState: State, trigger: string) {
    const prev = state;
    clearStateful();
    state = newState;
    if (prev !== newState) log(`${prev} → ${newState} (${trigger})`);

    if (newState === State.FAST) {
        pollTimer = setInterval(tryAcceptAll, cfg.fastMs);
        stateTimer = setTimeout(() => transitionTo(State.SLOW, 'fastExpired'), cfg.fastDuration);
        updateStatusBar();
    } else if (newState === State.SLOW) {
        pollTimer = setInterval(tryAcceptAll, cfg.slowMs);
        stateTimer = setTimeout(() => transitionTo(State.IDLE, 'cooldown'), cfg.cooldownDuration);
        updateStatusBar();
    } else {
        updateStatusBar();
    }
}

function clearStateful() {
    if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
    if (stateTimer !== undefined) { clearTimeout(stateTimer); stateTimer = undefined; }
}

function clearAll() {
    clearStateful();
    if (heartbeatTimer !== undefined) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (sleepTimer !== undefined) { clearInterval(sleepTimer); sleepTimer = undefined; }
    if (textChangeTimer !== undefined) { clearTimeout(textChangeTimer); textChangeTimer = undefined; }
}

// ══════════════════════════════════════════════════════════════════
// Event Listeners
// ══════════════════════════════════════════════════════════════════

function invalidateCaches(reason: string) {
    // Invalidate gRPC cache so we rediscover the (possibly new) language server
    grpcServer = null;
    grpcCacheTime = 0;
    // Disconnect CDP so we reconnect to fresh targets
    cdpDisconnect();
    // Reset CDP fail tracking so we try fresh
    cdpFailCount = 0;
    cdpRestartPrompted = false;
    cdpNotifyCount = 0;
    log(`Caches invalidated (${reason})`);
}

function registerEvents() {
    disposeEvents();
    const wake = (name: string) => () => { if (enabled) transitionTo(State.FAST, name); };

    events = [
        vscode.window.onDidChangeActiveTerminal(wake('terminal')),
        vscode.window.onDidOpenTerminal(t => {
            // A new terminal opening after restart means fresh AG session
            invalidateCaches('terminalOpen');
            if (enabled) transitionTo(State.FAST, 'terminalOpen');
        }),
        vscode.window.onDidCloseTerminal(wake('terminalClose')),
        vscode.window.onDidChangeVisibleTextEditors(wake('editorsChanged')),
        vscode.window.onDidChangeActiveTextEditor(wake('editorChanged')),
        vscode.window.onDidChangeWindowState(e => {
            windowFocused = e.focused;
            if (e.focused && enabled) {
                // Window regaining focus after account switch/restart:
                // invalidate caches so we rediscover the new language server
                invalidateCaches('windowFocused');
                transitionTo(State.FAST, 'windowFocused');
            }
        }),
        vscode.workspace.onDidChangeTextDocument(() => {
            if (!enabled) return;
            if (textChangeTimer) clearTimeout(textChangeTimer);
            textChangeTimer = setTimeout(() => {
                if (enabled && state === State.IDLE) transitionTo(State.FAST, 'textChanged');
            }, 2000);
        }),
        vscode.workspace.onDidCreateFiles(wake('filesCreated')),
        vscode.workspace.onDidSaveTextDocument(wake('fileSaved')),
        vscode.tasks.onDidStartTask(wake('taskStarted')),
        vscode.tasks.onDidEndTask(wake('taskEnded')),
        vscode.debug.onDidStartDebugSession(wake('debugStarted')),
    ];
}

function disposeEvents() {
    events.forEach(d => d.dispose());
    events = [];
}

// ══════════════════════════════════════════════════════════════════
// Heartbeat + Sleep Detection
// ══════════════════════════════════════════════════════════════════

function startHeartbeat() {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (enabled && state === State.IDLE) tryAcceptAll();
    }, cfg.heartbeatMs);
}

function startSleepDetection() {
    if (sleepTimer !== undefined) clearInterval(sleepTimer);
    lastTickTime = Date.now();
    sleepTimer = setInterval(() => {
        const drift = Date.now() - lastTickTime;
        if (drift > 10000) {
            log(`Sleep detected (drift: ${drift}ms)`);
            if (enabled) transitionTo(State.FAST, 'sleepRecovery');
        }
        lastTickTime = Date.now();
    }, 5000);
}

// ══════════════════════════════════════════════════════════════════
// Core: 3-Layer Accept
// ══════════════════════════════════════════════════════════════════

async function tryAcceptAll() {
    if (!enabled || busy) return;
    busy = true;
    try {
        // Layer 1: gRPC (terminal commands — zero UI)
        await layer1_gRPC();
        // Layer 2: CDP DOM clicks (agent panel buttons)
        await layer2_CDP();
        // Layer 3: VS Code commands fallback
        await layer3_VSCode();
    } catch (e: any) {
        if (cfg.debugMode) log(`Error: ${e?.message || e}`);
    } finally {
        busy = false;
    }
}

// ─── Layer 1: gRPC ────────────────────────────────────────────────

async function layer1_gRPC() {
    try {
        const server = await discoverServer();
        if (!server) return;

        const allTrajs = await callGrpc(server, 'GetAllCascadeTrajectories', {});
        const summaries = allTrajs?.trajectorySummaries ?? {};

        for (const [cascadeId, summary] of Object.entries(summaries) as [string, any][]) {
            const trajectoryId = summary?.trajectoryId ?? '';
            const stepCount = summary?.stepCount ?? 0;
            if (stepCount === 0) continue;

            const stepOffset = Math.max(0, stepCount - 10);
            const stepsResult = await callGrpc(server, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset });
            const steps = stepsResult?.steps ?? [];

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                if (!step?.runCommand) continue;
                const status = step.status || '';
                if (status.includes('DONE') || status.includes('CANCEL') || status.includes('ERROR')) continue;

                const proposedCmd = step.runCommand.proposedCommandLine ?? step.runCommand.commandLine ?? '';
                if (!proposedCmd) continue;

                log(`[gRPC] Accepting step ${stepOffset + i}: ${proposedCmd.substring(0, 60)}`);
                await callGrpc(server, 'HandleCascadeUserInteraction', {
                    cascadeId,
                    interaction: {
                        trajectoryId,
                        stepIndex: stepOffset + i,
                        runCommand: {
                            confirm: true,
                            proposedCommandLine: proposedCmd,
                            submittedCommandLine: proposedCmd,
                        }
                    }
                });
            }
        }
    } catch (e: any) {
        if (cfg.debugMode) log(`[gRPC] ${e?.message || e}`);
    }
}

// ─── Layer 2: CDP DOM (persistent WS, mstrvn-style) ──────────────

async function layer2_CDP() {
    if (!cfg.enableCDP) return;

    // Ensure we have active connections
    await cdpEnsureConnections();

    if (cdpConnections.size === 0) {
        cdpFailCount++;
        if (cdpFailCount >= 10 && !cdpRestartPrompted) {
            // Show notification up to 3 times
            if (cdpNotifyCount < CDP_MAX_NOTIFY) {
                cdpNotifyCount++;
                log(`[CDP] No debug port found after ${cdpFailCount} attempts — notification ${cdpNotifyCount}/${CDP_MAX_NOTIFY}`);
                statusBar.text = '$(warning) AG: NO CDP';
                statusBar.tooltip = 'CDP debug port not active. Close and reopen AG to enable auto-accept.';
                statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

                // Auto-fix shortcuts silently in the background (only first time)
                if (cdpNotifyCount === 1) fixAgShortcuts(cfg.cdpPort);

                vscode.window.showWarningMessage(
                    `GravityPilot (${cdpNotifyCount}/${CDP_MAX_NOTIFY}): Shortcuts updated with debug port. Close AG completely and reopen from shortcut for auto-accept to work.`,
                    'OK', 'Ignore'
                ).then(choice => {
                    if (choice === 'Ignore') {
                        cdpRestartPrompted = true; // stop future notifications
                        log('[CDP] User chose to ignore CDP notifications');
                    }
                });
            } else {
                cdpRestartPrompted = true; // 3 notifications shown, stop
            }
        }
        return;
    }
    cdpFailCount = 0;
    if (cdpRestartPrompted) {
        cdpRestartPrompted = false;
        updateStatusBar();
    }

    const safePatterns = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'continue', 'proceed'];
    const unsafePatterns = godMode ? ['always allow', 'allow this conversation', 'allow'] : [];
    const allPatterns = [...safePatterns, ...unsafePatterns];
    const rejectPatterns = ['skip', 'reject', 'cancel', 'close', 'refine', 'always run'];

    // Persistent script: injected ONCE, runs its own internal loop
    const persistentScript = `
(function() {
    if (window.__gpInjected) return;
    window.__gpInjected = true;

    function scanAndClick(PATTERNS, REJECTS) {
        var clicked = 0;
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.textContent || '').trim().toLowerCase();
            if (!text || text.length > 50) continue;
            if (btn.disabled) continue;
            try {
                var style = window.getComputedStyle(btn);
                var rect = btn.getBoundingClientRect();
                if (style.display === 'none' || rect.width === 0 || style.pointerEvents === 'none') continue;
            } catch(e) { continue; }
            if (REJECTS.some(function(r) { return text.includes(r); })) continue;
            if (!PATTERNS.some(function(p) { return text.includes(p); })) continue;
            btn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
            clicked++;
        }
        return clicked;
    }

    function scrollToBottom() {
        var scrollBtns = document.querySelectorAll('button[aria-label="Scroll to bottom"]');
        var scrolled = 0;
        for (var s = 0; s < scrollBtns.length; s++) {
            var sb = scrollBtns[s];
            try {
                var sStyle = window.getComputedStyle(sb);
                var sRect = sb.getBoundingClientRect();
                if (sStyle.display !== 'none' && sRect.width > 0 && !sb.disabled) {
                    sb.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                    scrolled++;
                }
            } catch(e) {}
        }
        return scrolled;
    }

    // Internal autonomous loop — NEVER dies
    function loop() {
        try {
            if (!window.__gpConfig) { setTimeout(loop, 800); return; }
            var P = window.__gpConfig.patterns;
            var R = window.__gpConfig.rejects;

            // Step 1: Try clicking buttons already in DOM
            var clicked = scanAndClick(P, R);

            // Step 2: If nothing found, scroll to bottom and retry
            if (clicked === 0) {
                var scrolled = scrollToBottom();
                if (scrolled > 0) {
                    setTimeout(function() { try { scanAndClick(P, R); } catch(e) {} }, 300);
                }
            }
        } catch(e) {}

        setTimeout(loop, 800);
    }

    loop();
    console.log('[GravityPilot] Persistent script injected');
})()`;

    // Config update script: updates patterns without re-injecting
    const configScript = `window.__gpConfig = { patterns: ${JSON.stringify(allPatterns)}, rejects: ${JSON.stringify(rejectPatterns)} }`;

    for (const [id, conn] of cdpConnections) {
        try {
            // Always push latest config (god mode changes, etc.)
            await cdpEvaluate(conn.ws, configScript);

            // Inject persistent script only once per connection
            if (!conn.injected) {
                await cdpEvaluate(conn.ws, persistentScript);
                conn.injected = true;
                log(`[CDP] Persistent script injected into ${id}`);
            }
        } catch {
            // Connection dead — prune it so next cycle reconnects
            log(`[CDP] Connection ${id} failed, removing`);
            try { conn.ws.close(); } catch { }
            cdpConnections.delete(id);
        }
    }
}

// ─── Layer 3: VS Code Commands ────────────────────────────────────

async function layer3_VSCode() {
    await Promise.allSettled(
        ACCEPT_CMDS.map(cmd => vscode.commands.executeCommand(cmd))
    );
}

// ══════════════════════════════════════════════════════════════════
// gRPC Server Discovery (from ayesman pattern)
// ══════════════════════════════════════════════════════════════════

async function discoverServer() {
    if (grpcServer && Date.now() - grpcCacheTime < 60000) return grpcServer;

    try {
        const procs = await findLanguageServerProcesses();
        for (const proc of procs) {
            const csrfMatch = proc.cmdline.match(/--csrf_token\s+(\S+)/);
            if (!csrfMatch) continue;
            const csrfToken = csrfMatch[1];
            const ports = await findListeningPorts(proc.pid);
            for (const port of ports) {
                for (const useHttps of [true, false]) {
                    try {
                        const ok = await probePort(port, csrfToken, useHttps);
                        if (ok) {
                            grpcServer = { port, csrfToken, useHttps };
                            grpcCacheTime = Date.now();
                            log(`[gRPC] Connected to port ${port}`);
                            return grpcServer;
                        }
                    } catch { }
                }
            }
        }
    } catch { }
    return null;
}

function callGrpc(server: { port: number; csrfToken: string; useHttps: boolean }, method: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const opts = {
            hostname: '127.0.0.1', port: server.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': server.csrfToken,
                'Connect-Protocol-Version': '1',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 5000,
            rejectUnauthorized: false,
        };
        const makeReq = server.useHttps ? https.request : http.request;
        const req = makeReq(opts, res => {
            let body = '';
            res.on('data', (c: string) => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

function probePort(port: number, csrfToken: string, useHttps: boolean): Promise<boolean> {
    return new Promise(resolve => {
        const opts = {
            hostname: '127.0.0.1', port,
            path: '/exa.language_server_pb.LanguageServerService/Heartbeat',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken, 'Connect-Protocol-Version': '1' },
            timeout: 2000, rejectUnauthorized: false,
        };
        const makeReq = useHttps ? https.request : http.request;
        const req = makeReq(opts, res => {
            res.on('data', () => { });
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write('{}');
        req.end();
    });
}

async function findLanguageServerProcesses(): Promise<{ pid: number; cmdline: string }[]> {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name LIKE 'language_server%'\\" | ForEach-Object { Write-Output \\"$($_.ProcessId)::::$($_.CommandLine)\\" }"`,
                { timeout: 10000 }
            );
            return stdout.split(/\r?\n/).filter(Boolean).map(line => {
                const [pid, ...rest] = line.split('::::');
                return { pid: parseInt(pid, 10), cmdline: rest.join('::::') };
            }).filter(p => p.pid && p.cmdline);
        } else {
            const { stdout } = await execAsync("ps -eo pid,args | grep 'language_server' | grep -v grep", { timeout: 10000 });
            return stdout.split('\n').filter(Boolean).map(line => {
                const parts = line.trim().split(/\s+/);
                return { pid: parseInt(parts[0], 10), cmdline: parts.slice(1).join(' ') };
            }).filter(p => p.pid && p.cmdline);
        }
    } catch { return []; }
}

async function findListeningPorts(pid: number): Promise<number[]> {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync('netstat -ano', { timeout: 10000 });
            const ports: number[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
                if (parseInt(parts[4], 10) !== pid) continue;
                const portMatch = parts[1].match(/:(\d+)$/);
                if (portMatch) ports.push(parseInt(portMatch[1], 10));
            }
            return [...new Set(ports)];
        } else {
            const { stdout } = await execAsync(`lsof -a -i -n -P -p ${pid} 2>/dev/null | grep LISTEN`, { timeout: 10000 });
            return [...new Set(stdout.split('\n').map(l => l.match(/:(\d+)\s+\(LISTEN\)/)?.[1]).filter(Boolean).map(Number))];
        }
    } catch { return []; }
}

// ══════════════════════════════════════════════════════════════════
// CDP Helpers (persistent WS connections like mstrvn)
// ══════════════════════════════════════════════════════════════════

function cdpGetPages(port: number): Promise<any[]> {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, res => {
            let body = '';
            res.on('data', (c: Buffer) => body += c);
            res.on('end', () => {
                try {
                    const pages = JSON.parse(body);
                    resolve(pages.filter((p: any) => p.webSocketDebuggerUrl && (p.type === 'page' || p.type === 'webview')));
                } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
    });
}

async function cdpEnsureConnections() {
    const now = Date.now();
    // Prune dead/stale connections AND age-expired connections
    for (const [id, conn] of cdpConnections) {
        const age = now - conn.connectedAt;
        if (conn.ws.readyState !== WebSocket.OPEN) {
            log(`[CDP] Pruning dead connection ${id} (readyState: ${conn.ws.readyState})`);
            try { conn.ws.close(); } catch { }
            cdpConnections.delete(id);
        } else if (age > CDP_MAX_AGE_MS) {
            log(`[CDP] Recycling aged connection ${id} (${Math.round(age / 60000)}min old)`);
            try { conn.ws.removeAllListeners(); conn.ws.close(); } catch { }
            cdpConnections.delete(id);
        }
    }

    // Strategy 1: Try known/cached port first, then hardcoded ports
    const portsToTry = cdpPortFound ? [cdpPortFound, ...CDP_PORTS.filter(p => p !== cdpPortFound)] : [...CDP_PORTS];

    // Strategy 2: Discover AG process ports dynamically
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync(
                'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'Antigravity.exe\'\\" | Select-Object -Expand ProcessId"',
                { timeout: 3000 }
            );
            const agPids = stdout.split(/\r?\n/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (agPids.length > 0) {
                const { stdout: netstatOut } = await execAsync('netstat -ano', { timeout: 5000 });
                for (const line of netstatOut.split(/\r?\n/)) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
                    const pid = parseInt(parts[4]);
                    if (!agPids.includes(pid)) continue;
                    const portMatch = parts[1].match(/:(\d+)$/);
                    if (portMatch) {
                        const dynPort = parseInt(portMatch[1]);
                        if (!portsToTry.includes(dynPort)) portsToTry.push(dynPort);
                    }
                }
            }
        }
    } catch { /* dynamic scan failed, continue with static ports */ }

    for (const port of portsToTry) {
        try {
            const pages = await cdpGetPages(port);
            if (pages.length === 0) continue;
            cdpPortFound = port;
            log(`[CDP] Found CDP on port ${port}`);

            for (const page of pages) {
                const id = `${port}:${page.id}`;
                if (cdpConnections.has(id)) continue;

                try {
                    const ws = new WebSocket(page.webSocketDebuggerUrl);
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
                        ws.on('open', () => {
                            clearTimeout(timeout);
                            cdpConnections.set(id, { ws, id, injected: false, connectedAt: Date.now() });
                            log(`[CDP] Connected to ${id}`);
                            resolve();
                        });
                        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
                    });
                    ws.on('close', () => {
                        cdpConnections.delete(id);
                        log(`[CDP] Disconnected from ${id}`);
                    });
                    ws.on('error', () => { });
                } catch { /* skip this target */ }
            }

            if (cdpConnections.size > 0) return; // connected, stop scanning
        } catch { /* port not open */ }
    }
}

function cdpEvaluate(ws: WebSocket, expression: string): Promise<any> {
    return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('not open'));
        const id = cdpMsgId++;
        const cleanup = () => { ws.off('message', onMessage); clearTimeout(timer); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 4000);
        const onMessage = (data: WebSocket.Data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                    cleanup();
                    resolve(msg.result?.result?.value);
                }
            } catch { }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, userGesture: true, awaitPromise: false, returnByValue: true }
        }));
    });
}

function cdpDisconnect() {
    if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null; }
    for (const [, conn] of cdpConnections) {
        try { conn.ws.removeAllListeners(); conn.ws.close(); } catch { }
    }
    cdpConnections.clear();
    cdpPortFound = null;
    cdpMsgId = 1; // reset to prevent unbounded growth
}

// ══════════════════════════════════════════════════════════════════
// Auto CDP Port Setup — shortcut modification + argv.json
// ══════════════════════════════════════════════════════════════════

function fixAgShortcuts(port: number) {
    if (process.platform !== 'win32') {
        log('[CDP] Shortcut fix only supported on Windows');
        return;
    }

    const script = `
$ErrorActionPreference = "SilentlyContinue"
$WshShell = New-Object -ComObject WScript.Shell
$foundShortcuts = @()
$searchLocations = @(
    [Environment]::GetFolderPath('Desktop'),
    "$env:USERPROFILE\\Desktop",
    "$env:USERPROFILE\\OneDrive\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:USERPROFILE\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)
foreach ($location in $searchLocations) {
    if (Test-Path $location) {
        $shortcuts = Get-ChildItem -Path $location -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*Antigravity*" }
        if ($shortcuts) { $foundShortcuts += $shortcuts }
    }
}
if ($foundShortcuts.Count -eq 0) {
    $exePath = "$env:LOCALAPPDATA\\Programs\\Antigravity\\Antigravity.exe"
    if (Test-Path $exePath) {
        $desktopPath = [Environment]::GetFolderPath('Desktop')
        $shortcutPath = "$desktopPath\\Antigravity.lnk"
        $shortcut = $WshShell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $exePath
        $shortcut.Arguments = "--remote-debugging-port=${port}"
        $shortcut.Save()
    }
} else {
    foreach ($shortcutFile in $foundShortcuts) {
        $shortcut = $WshShell.CreateShortcut($shortcutFile.FullName)
        $originalArgs = $shortcut.Arguments
        if ($originalArgs -match "--remote-debugging-port=\\d+") {
            $shortcut.Arguments = $originalArgs -replace "--remote-debugging-port=\\d+", "--remote-debugging-port=${port}"
        } else {
            $shortcut.Arguments = "--remote-debugging-port=${port} " + $originalArgs
        }
        $shortcut.Save()
    }
}
exit 0
`;

    const tmpScript = path.join(os.tmpdir(), 'gp-cdp-setup.ps1');
    try {
        fs.writeFileSync(tmpScript, script, 'utf8');
        const ps = (require('child_process') as typeof import('child_process')).spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript
        ], { windowsHide: true, stdio: 'ignore', detached: true });
        ps.unref();
        ps.on('exit', () => {
            try { fs.unlinkSync(tmpScript); } catch { }
            log('[CDP] Shortcuts updated with debug port');
        });
        ps.on('error', (e) => {
            log(`[CDP] Shortcut fix failed: ${e.message}`);
        });
    } catch (e: any) {
        log(`[CDP] fixAgShortcuts error: ${e?.message}`);
    }
}

async function ensureDebugPort(): Promise<number | null> {
    const port = cfg.cdpPort;
    const home = os.homedir();
    const agPath = path.join(home, '.antigravity', 'argv.json');
    const vsPath = path.join(home, '.vscode', 'argv.json');
    const argvPath = fs.existsSync(agPath) ? agPath : fs.existsSync(vsPath) ? vsPath : agPath;

    try {
        // Step 1: Write argv.json (works for older AG versions)
        let data: any = {};
        if (fs.existsSync(argvPath)) {
            const raw = fs.readFileSync(argvPath, 'utf8');
            const cleaned = raw.replace(/\/\/.*$/gm, '');
            data = JSON.parse(cleaned);
        }
        if (!data['remote-debugging-port']) {
            data['remote-debugging-port'] = port;
            const dir = path.dirname(argvPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(argvPath, JSON.stringify(data, null, 2), 'utf8');
            log(`[CDP] Wrote debug port ${port} to ${argvPath}`);
        }

        // Step 2: Check if the current process already has the debug port active
        const cmdline = process.argv.join(' ');
        if (cmdline.includes('remote-debugging-port')) {
            log(`[CDP] Debug port flag already active in process args`);
            return port;
        }

        log(`[CDP] Debug port ${port} configured in argv.json but may need AG restart with --remote-debugging-port=${port}`);
        return null;
    } catch (e: any) {
        log(`[CDP] ensureDebugPort error: ${e?.message}`);
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════
// Status Bars
// ══════════════════════════════════════════════════════════════════

function updateStatusBar() {
    if (!statusBar) return;
    if (!enabled) {
        statusBar.text = '$(circle-slash) AG: OFF';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBar.tooltip = 'Click to enable';
    } else if (state === State.FAST) {
        statusBar.text = '$(check) AG: FAST';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBar.tooltip = `FAST mode (${cfg.fastMs}ms) | CDP: ${cdpPortFound ? '✓ :' + cdpPortFound : '✗'} | gRPC: ${grpcServer ? '✓' : '✗'}`;
    } else if (state === State.SLOW) {
        statusBar.text = '$(eye) AG: SLOW';
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = `SLOW mode (${cfg.slowMs}ms)`;
    } else {
        statusBar.text = '$(clock) AG: IDLE';
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = `IDLE (heartbeat ${cfg.heartbeatMs}ms)`;
    }
}

function updateGodModeBar() {
    if (!godModeBar) return;
    if (godMode) {
        godModeBar.text = '$(flame) GOD';
        godModeBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        godModeBar.tooltip = '⚠️ God Mode ON — folder access auto-allowed';
    } else {
        godModeBar.text = '$(shield) Safe';
        godModeBar.backgroundColor = undefined;
        godModeBar.tooltip = 'God Mode OFF — folder prompts need manual approval';
    }
}

// ══════════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════════

async function verifyCommands() {
    try {
        const all = await vscode.commands.getCommands(true);
        const set = new Set(all);
        let found = 0;
        for (const cmd of ACCEPT_CMDS) { if (set.has(cmd)) found++; }
        log(`Commands: ${found}/${ACCEPT_CMDS.length} available`);
    } catch { }
}

function log(msg: string) {
    if (!out) return;
    if (logLines >= 100) { out.clear(); logLines = 0; }
    out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    logLines++;
}

// ══════════════════════════════════════════════════════════════════
// Deactivation
// ══════════════════════════════════════════════════════════════════

export function deactivate() {
    clearAll();
    disposeEvents();
    cdpDisconnect();
}
