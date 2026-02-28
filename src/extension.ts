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

// CDP — scan multiple ports like mstrvn/auto-run-pro
const CDP_PORTS = [9222, 9229, ...Array.from({ length: 18 }, (_, i) => 8997 + i)];
let cdpPortFound: number | null = null;

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
    out = vscode.window.createOutputChannel('AG Super Auto-Accept');
    log('v4.0 activated');
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

        // Auto-setup CDP
        if (cfg.enableCDP) {
            ensureDebugPort(); // best-effort argv.json setup for next restart
        }
    }

    log('Ready');
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

function registerEvents() {
    disposeEvents();
    const wake = (name: string) => () => { if (enabled) transitionTo(State.FAST, name); };

    events = [
        vscode.window.onDidChangeActiveTerminal(wake('terminal')),
        vscode.window.onDidOpenTerminal(wake('terminalOpen')),
        vscode.window.onDidCloseTerminal(wake('terminalClose')),
        vscode.window.onDidChangeVisibleTextEditors(wake('editorsChanged')),
        vscode.window.onDidChangeActiveTextEditor(wake('editorChanged')),
        vscode.window.onDidChangeWindowState(e => {
            windowFocused = e.focused;
            if (e.focused && enabled) transitionTo(State.FAST, 'windowFocused');
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

// ─── Layer 2: CDP DOM (multi-port scan, all-target evaluation) ────

async function layer2_CDP() {
    if (!cfg.enableCDP) return;

    const safeTexts = ['run', 'accept', 'accept all', 'continue', 'proceed', 'allow once'];
    const unsafeTexts = godMode ? ['always allow', 'allow this conversation', 'allow'] : [];
    const allTexts = [...safeTexts, ...unsafeTexts];

    const script = `
(function() {
    if (!document.querySelector('.react-app-container') &&
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }
    var TEXTS = ${JSON.stringify(allTexts)};
    var clicked = 0;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var text = '';
        for (var j = 0; j < btn.childNodes.length; j++) {
            if (btn.childNodes[j].nodeType === 3) text += btn.childNodes[j].textContent;
        }
        text = text.trim().toLowerCase();
        if (!text || text.length > 50) continue;
        if (btn.offsetParent === null) continue;
        var matched = false;
        for (var k = 0; k < TEXTS.length; k++) {
            if (text === TEXTS[k] || text.startsWith(TEXTS[k] + ' alt+') || text.startsWith(TEXTS[k] + ' ctrl+') ||
                (TEXTS[k] === 'accept' && text.startsWith('accept'))) {
                matched = true; break;
            }
        }
        if (matched) { btn.click(); clicked++; }
    }
    return 'clicked:' + clicked;
})()`;

    // Scan ports to find active CDP endpoint
    const portsToTry = cdpPortFound ? [cdpPortFound, ...CDP_PORTS.filter(p => p !== cdpPortFound)] : CDP_PORTS;

    for (const port of portsToTry) {
        try {
            const pages = await cdpGetPages(port);
            if (pages.length === 0) continue;
            cdpPortFound = port; // cache working port

            // Evaluate on ALL targets — webview guard handles isolation
            for (const page of pages) {
                try {
                    const result = await cdpEvaluateOnce(page.webSocketDebuggerUrl, script);
                    if (result && typeof result === 'string' && result.startsWith('clicked:')) {
                        const count = parseInt(result.split(':')[1], 10);
                        if (count > 0) {
                            log(`[CDP] ✓ ${result} on port ${port}`);
                        }
                    }
                } catch { /* skip target */ }
            }
            return; // found correct port, stop scanning
        } catch { /* port not open */ }
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
    if (grpcServer && Date.now() - grpcCacheTime < 300000) return grpcServer;

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
// CDP Helpers (scan multiple ports, fresh WS per eval like auto-run-pro)
// ══════════════════════════════════════════════════════════════════

function cdpGetPages(port: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
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

function cdpEvaluateOnce(wsUrl: string, expression: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
        });
        ws.on('message', (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                clearTimeout(timeout);
                ws.close();
                resolve(msg.result?.result?.value || '');
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
    });
}

function cdpDisconnect() {
    cdpPortFound = null;
}

// ══════════════════════════════════════════════════════════════════
// Auto CDP Port Setup (argv.json)
// ══════════════════════════════════════════════════════════════════

async function ensureDebugPort(): Promise<number | null> {
    const port = cfg.cdpPort;
    const home = os.homedir();
    const agPath = path.join(home, '.antigravity', 'argv.json');
    const vsPath = path.join(home, '.vscode', 'argv.json');
    const argvPath = fs.existsSync(agPath) ? agPath : fs.existsSync(vsPath) ? vsPath : agPath;

    try {
        let data: any = {};
        if (fs.existsSync(argvPath)) {
            const raw = fs.readFileSync(argvPath, 'utf8');
            // Strip // comments for JSON parsing
            const cleaned = raw.replace(/\/\/.*$/gm, '');
            data = JSON.parse(cleaned);
        }
        if (data['remote-debugging-port']) {
            log(`[CDP] Debug port already set: ${data['remote-debugging-port']}`);
            return data['remote-debugging-port'];
        }

        data['remote-debugging-port'] = port;
        const dir = path.dirname(argvPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(argvPath, JSON.stringify(data, null, 2), 'utf8');
        log(`[CDP] Wrote debug port ${port} to ${argvPath}`);

        const action = await vscode.window.showInformationMessage(
            'AG Auto-Accept: CDP configured. Restart IDE for full button acceptance.',
            'Restart Now', 'Later'
        );
        if (action === 'Restart Now') vscode.commands.executeCommand('workbench.action.reloadWindow');
        return null;
    } catch (e: any) {
        log(`[CDP] argv.json error: ${e?.message}`);
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
