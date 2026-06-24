"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");

const SCHRUNE_KEYWORDS = [
  "module",
  "part",
  "rail",
  "net",
  "val",
  "new",
  "top",
  "if",
  "else",
  "for",
  "return",
];

const SCHRUNE_BUILTINS = [
  "Resistor",
  "Capacitor",
  "Inductor",
  "Diode",
];

const SCHRUNE_NET_TYPES = [
  "i2c",
  "uart",
  "spi",
];

const SCHRUNE_OPENABLE_OUTPUTS = {
  schematic: "kicad_sch",
  layout: "kicad_pcb",
};

let outputChannel;
let cliProvider;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Schrune");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "schrune" },
      new SchruneCompletionProvider(context),
      " ",
      "#",
      ".",
      "<",
      "(",
      ","
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.buildCurrentFile", () => buildCurrentFile(context, false))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.buildFile", () => buildSelectedFile(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.addPart", () => addPart(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.openSchematic", () => openGeneratedKiCadFile(context, "schematic"))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.openLayout", () => openGeneratedKiCadFile(context, "layout"))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("schrune.refreshCliView", () => {
      if (cliProvider) {
        cliProvider.refresh();
      }
    })
  );

  cliProvider = new SchruneCliProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("schruneCliView", cliProvider)
  );
}

function deactivate() {}

class SchruneCompletionProvider {
  async provideCompletionItems(document, position) {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const currentWord = extractCurrentWord(linePrefix);
    const contextKind = detectCompletionContext(linePrefix, textBefore);
    const symbols = await collectProjectSymbols(document);

    if (contextKind === "include") {
      return buildIncludeCompletions(document, linePrefix, currentWord);
    }

    if (contextKind === "new") {
      return buildNamedSymbolCompletions(currentWord, [
        ...SCHRUNE_BUILTINS.map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Built-in part" })),
        ...[...symbols.parts].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Part definition" })),
        ...[...symbols.modules].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Module definition" })),
      ]);
    }

    if (contextKind === "netType") {
      return buildNamedSymbolCompletions(currentWord, SCHRUNE_NET_TYPES.map((name) => ({
        name,
        kind: vscode.CompletionItemKind.EnumMember,
        detail: "Typed net",
      })));
    }

    if (contextKind === "connection" || contextKind === "identifier") {
      const items = buildNamedSymbolCompletions(currentWord, [
        ...[...symbols.nets].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Net" })),
        ...[...symbols.instances].map((name) => ({
          name,
          kind: vscode.CompletionItemKind.Reference,
          detail: "Part or module instance",
        })),
      ]);
      if (items.length) {
        return items;
      }
    }

    return buildGeneralCompletions(currentWord, symbols);
  }
}

class SchruneCliProvider {
  constructor(context) {
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element) {
      return [];
    }
    return [
      makeActionItem("Build current file", "Run Schrune build for the active editor", "schrune.buildCurrentFile"),
      makeActionItem("Build file...", "Choose a .schrune file and build it", "schrune.buildFile"),
      makeActionItem("Add LCSC part...", "Download and scaffold a part library entry", "schrune.addPart"),
      makeActionItem("Open schematic in KiCad", "Open the generated schematic for the active design", "schrune.openSchematic"),
      makeActionItem("Open layout in KiCad", "Open the generated PCB layout for the active design", "schrune.openLayout"),
    ];
  }
}

function makeActionItem(label, description, command) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.command = { command, title: label };
  item.contextValue = "schruneCliAction";
  return item;
}

function getSnippets() {
  const snippets = [];

  const moduleTop = new vscode.CompletionItem("module top", vscode.CompletionItemKind.Snippet);
  moduleTop.insertText = new vscode.SnippetString(
    [
      '#include "Parts.schrune"',
      "",
      "module top () {",
      "\t$0",
      "}",
      "",
    ].join("\n")
  );
  moduleTop.detail = "Top-level module";
  snippets.push(moduleTop);

  const partInstance = new vscode.CompletionItem("part instance", vscode.CompletionItemKind.Snippet);
  partInstance.insertText = new vscode.SnippetString("part ${1:name} = new ${2:PartType}(${3});");
  partInstance.detail = "Instantiate a part";
  snippets.push(partInstance);

  const netTyped = new vscode.CompletionItem("typed net", vscode.CompletionItemKind.Snippet);
  netTyped.insertText = new vscode.SnippetString("net<${1:i2c}> ${2:bus};");
  netTyped.detail = "Declare a typed net";
  snippets.push(netTyped);

  const railSnippet = new vscode.CompletionItem("rail", vscode.CompletionItemKind.Snippet);
  railSnippet.insertText = new vscode.SnippetString(
    [
      "rail ${1:power};",
      "${1:power}.h.name = \"${2:VCC}\";",
      "${1:power}.l.name = \"${3:GND}\";",
    ].join("\n")
  );
  railSnippet.detail = "Declare a rail";
  snippets.push(railSnippet);

  const includeSnippet = new vscode.CompletionItem("include", vscode.CompletionItemKind.Snippet);
  includeSnippet.insertText = new vscode.SnippetString('#include "${1:Parts.schrune}"');
  includeSnippet.detail = "Include another Schrune file";
  snippets.push(includeSnippet);

  return snippets;
}

function detectCompletionContext(linePrefix, textBefore) {
  if (/^\s*#include\s*$/.test(linePrefix) || /#include\s+["'][^"']*$/.test(linePrefix)) {
    return "include";
  }

  if (/\bnew\s+[A-Za-z_]\w*$/.test(textBefore)) {
    return "new";
  }

  if (/\bnet<[^>]*$/.test(textBefore)) {
    return "netType";
  }

  if (/[~>=,(]\s*[A-Za-z_]\w*$/.test(linePrefix) || /\b(?:net|rail|part|mod)\s+[A-Za-z_]\w*$/.test(linePrefix)) {
    return "connection";
  }

  if (/[A-Za-z_]\w*$/.test(linePrefix)) {
    return "identifier";
  }

  return "general";
}

function extractCurrentWord(text) {
  const match = text.match(/([A-Za-z_]\w*)$/);
  return match ? match[1] : "";
}

function buildNamedSymbolCompletions(prefix, entries) {
  const normalizedPrefix = prefix.toLowerCase();
  return entries
    .filter((entry) => !normalizedPrefix || entry.name.toLowerCase().startsWith(normalizedPrefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const item = new vscode.CompletionItem(entry.name, entry.kind);
      item.detail = entry.detail;
      return item;
    });
}

function buildGeneralCompletions(prefix, symbols) {
  const normalizedPrefix = prefix.toLowerCase();
  const candidates = [
    ...SCHRUNE_KEYWORDS.map((name) => ({ name, kind: vscode.CompletionItemKind.Keyword, detail: "Schrune keyword" })),
    ...[...symbols.parts].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Part definition" })),
    ...[...symbols.modules].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Module definition" })),
    ...[...symbols.nets].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Net" })),
    ...[...symbols.instances].map((name) => ({
      name,
      kind: vscode.CompletionItemKind.Reference,
      detail: "Part or module instance",
    })),
  ];

  const items = [];
  for (const candidate of candidates.sort((left, right) => left.name.localeCompare(right.name))) {
    if (normalizedPrefix && !candidate.name.toLowerCase().startsWith(normalizedPrefix)) {
      continue;
    }

    const item = new vscode.CompletionItem(candidate.name, candidate.kind);
    item.detail = candidate.detail;
    items.push(item);
  }

  if (!normalizedPrefix || normalizedPrefix.length < 2) {
    items.push(...getSnippets());
  }

  return items;
}

async function buildIncludeCompletions(document, linePrefix, currentWord) {
  const includeFiles = await findSchruneFiles();
  return includeFiles
    .filter((filePath) => !currentWord || path.basename(filePath, ".schrune").toLowerCase().startsWith(currentWord.toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => {
      const relative = toRelativeIncludePath(document.uri, filePath);
      const item = new vscode.CompletionItem(path.basename(filePath, ".schrune"), vscode.CompletionItemKind.File);
      item.insertText = /["']/.test(linePrefix) ? relative : `"${relative}"`;
      item.detail = "Schrune include";
      return item;
    });
}

async function collectProjectSymbols(document) {
  const symbols = {
    parts: new Set(),
    modules: new Set(),
    nets: new Set(),
    instances: new Set(),
  };
  const visited = new Set();

  await collectDocumentSymbols(document.uri.fsPath, document.getText(), symbols, visited, true);
  return symbols;
}

async function collectDocumentSymbols(filePath, sourceText, symbols, visited, isRoot) {
  const resolvedPath = path.resolve(filePath);
  if (visited.has(resolvedPath)) {
    return;
  }

  visited.add(resolvedPath);

  const source = isRoot ? sourceText : readTextFileIfExists(resolvedPath);
  if (source === undefined) {
    return;
  }

  const normalizedSource = stripComments(source);
  collectLocalSymbols(normalizedSource, symbols);

  for (const includeName of extractIncludes(normalizedSource)) {
    const includePath = await resolveIncludePath(path.dirname(resolvedPath), includeName);
    if (includePath) {
      await collectDocumentSymbols(includePath, undefined, symbols, visited, false);
    }
  }
}

function collectLocalSymbols(source, symbols) {
  const partDefinitionPattern = /^\s*part\s+([A-Za-z_]\w*)\s*\{/gm;
  const moduleDefinitionPattern = /^\s*module\s+([A-Za-z_]\w*)/gm;
  const instancePattern = /^\s*(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+[A-Za-z_]\w*/gm;
  const moduleInstancePattern = /^\s*mod\s+([A-Za-z_]\w*)\s*=\s*new\s+[A-Za-z_]\w*/gm;
  const netDeclarationPattern = /^\s*net(?:<[^>]+>)?\s+([A-Za-z_]\w*)/gm;
  const railDeclarationPattern = /^\s*rail\s+([A-Za-z_]\w*)/gm;

  for (const match of source.matchAll(partDefinitionPattern)) {
    symbols.parts.add(match[1]);
  }

  for (const match of source.matchAll(moduleDefinitionPattern)) {
    symbols.modules.add(match[1]);
  }

  for (const match of source.matchAll(instancePattern)) {
    symbols.instances.add(match[1]);
  }

  for (const match of source.matchAll(moduleInstancePattern)) {
    symbols.instances.add(match[1]);
  }

  for (const match of source.matchAll(netDeclarationPattern)) {
    symbols.nets.add(match[1]);
  }

  for (const match of source.matchAll(railDeclarationPattern)) {
    symbols.nets.add(match[1]);
  }
}

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, "");
}

function extractIncludes(source) {
  const includes = [];
  const pattern = /^\s*#include\s+["']([^"']+)["']/gm;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    includes.push(match[1]);
  }

  return includes;
}

function readTextFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return fs.readFileSync(filePath, "utf8");
}

async function resolveIncludePath(baseDir, includeName) {
  const normalized = includeName.replace(/\\/g, "/");
  const candidates = [path.resolve(baseDir, normalized)];
  if (!path.extname(normalized)) {
    candidates.push(path.resolve(baseDir, `${normalized}.schrune`));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  const basename = path.basename(normalized);
  const workspaceMatches = await vscode.workspace.findFiles(`**/${basename}`, "**/node_modules/**");
  for (const uri of workspaceMatches) {
    const candidate = uri.fsPath;
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    if (normalizedCandidate.endsWith(normalized) || path.basename(candidate) === basename) {
      return candidate;
    }
  }

  return undefined;
}

function isFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function discoverSymbols(document) {
  const text = document.getText();
  const parts = new Set();
  const modules = new Set();

  for (const match of text.matchAll(/^\s*part\s+([A-Za-z_]\w*)\s*\{/gm)) {
    parts.add(match[1]);
  }

  for (const match of text.matchAll(/^\s*module\s+([A-Za-z_]\w*)/gm)) {
    modules.add(match[1]);
  }

  return { parts, modules };
}

async function findSchruneFiles() {
  const files = await vscode.workspace.findFiles("**/*.schrune", "**/node_modules/**");
  return files.map((uri) => uri.fsPath);
}

function toRelativeIncludePath(documentUri, targetPath) {
  const docDir = path.dirname(documentUri.fsPath);
  const relative = path.relative(docDir, targetPath).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function getCliConfig() {
  const config = vscode.workspace.getConfiguration("schrune.cli");
  return {
    executable: normalizeCommand(config.get("executable", "")),
    scriptPath: normalizePathSetting(config.get("scriptPath", "")),
  };
}

function getKiCadConfig() {
  const config = vscode.workspace.getConfiguration("schrune.kicad");
  return {
    executable: normalizeCommand(config.get("executable", "")),
  };
}

function normalizeCommand(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePathSetting(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultCliCommand(context) {
  const localApp = path.resolve(context.extensionPath, "..", "Schrune", "src", "app.js");
  if (fs.existsSync(localApp)) {
    return {
      command: process.execPath,
      args: [localApp],
      label: `node ${localApp}`,
    };
  }

  return {
    command: "schrune",
    args: [],
    label: "schrune",
  };
}

function resolveCliInvocation(context, extraArgs = []) {
  const configured = getCliConfig();
  const fallback = defaultCliCommand(context);

  if (configured.executable) {
    const args = configured.scriptPath ? [configured.scriptPath, ...extraArgs] : [...extraArgs];
    return {
      command: configured.executable,
      args,
      label: configured.scriptPath ? `${configured.executable} ${configured.scriptPath}` : configured.executable,
    };
  }

  return {
    command: fallback.command,
    args: [...fallback.args, ...extraArgs],
    label: fallback.label,
  };
}

async function buildCurrentFile(context, keepJs) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Open a Schrune file first.");
    return;
  }

  const document = editor.document;
  if (document.languageId !== "schrune" && !document.fileName.toLowerCase().endsWith(".schrune")) {
    vscode.window.showErrorMessage("The active editor is not a Schrune file.");
    return;
  }

  await runCli(context, "build", [keepJs ? "--keep-js" : null, document.uri.fsPath].filter(Boolean), path.dirname(document.uri.fsPath));
}

async function buildSelectedFile(context) {
  const file = await pickSchruneFile();
  if (!file) {
    return;
  }

  await runCli(context, "build", [file], path.dirname(file));
}

async function addPart(context) {
  const partNumber = await vscode.window.showInputBox({
    title: "Add Schrune part",
    prompt: 'Enter an LCSC part number like "C29823"',
    placeHolder: "C29823",
    validateInput: (value) => (/^C\d+$/i.test(value.trim()) ? undefined : "Use an LCSC part number like C29823"),
  });

  if (!partNumber) {
    return;
  }

  await runCli(context, "add", [partNumber.trim().toUpperCase()], vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

async function openGeneratedKiCadFile(context, kind) {
  const sourceFile = await resolveSourceFileForCurrentEditorOrPick();
  if (!sourceFile) {
    return;
  }

  const outputPath = getGeneratedKiCadPath(sourceFile, kind);
  if (!fs.existsSync(outputPath)) {
    vscode.window.showErrorMessage(`Missing generated KiCad file: ${outputPath}. Build the Schrune file first.`);
    return;
  }

  await runKiCad(context, outputPath, path.dirname(sourceFile));
}

function getGeneratedKiCadPath(sourceFile, kind) {
  const ext = SCHRUNE_OPENABLE_OUTPUTS[kind];
  const stem = path.basename(sourceFile, ".schrune");
  return path.join(path.dirname(sourceFile), "KiCad", `${stem}.${ext}`);
}

async function resolveSourceFileForCurrentEditorOrPick() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.toLowerCase().endsWith(".schrune")) {
    return editor.document.uri.fsPath;
  }

  return pickSchruneFile();
}

async function pickSchruneFile() {
  const files = await vscode.workspace.findFiles("**/*.schrune", "**/node_modules/**");
  if (!files.length) {
    vscode.window.showErrorMessage("No .schrune files found in the workspace.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    files.map((uri) => ({
      label: path.basename(uri.fsPath),
      description: path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(uri.fsPath), uri.fsPath),
      uri,
    })),
    {
      title: "Build Schrune file",
    }
  );

  return picked?.uri.fsPath;
}

async function runCli(context, subcommand, args, cwd) {
  const invocation = resolveCliInvocation(context, [subcommand, ...args]);
  const workingDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(invocation.command);

  outputChannel.show(true);
  outputChannel.appendLine(`> ${invocation.command} ${invocation.args.join(" ")}`);
  outputChannel.appendLine(`cwd: ${workingDir}`);

  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workingDir,
      env: process.env,
      shell: useShell,
      windowsHide: true,
    });

    child.stdout.on("data", (chunk) => {
      outputChannel.append(normalizeOutput(chunk));
    });
    child.stderr.on("data", (chunk) => {
      outputChannel.append(normalizeOutput(chunk));
    });

    child.on("error", (error) => {
      outputChannel.appendLine("");
      outputChannel.appendLine(error.message);
      reject(error);
    });

    child.on("close", (code) => {
      outputChannel.appendLine("");
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Schrune CLI exited with code ${code}`));
    });
  }).catch((error) => {
    vscode.window.showErrorMessage(error.message);
    return undefined;
  });
}

async function runKiCad(context, filePath, cwd) {
  const configured = getKiCadConfig();
  const command = configured.executable || "kicad";
  const workingDir = cwd || path.dirname(filePath);
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

  outputChannel.show(true);
  outputChannel.appendLine(`> ${command} ${filePath}`);
  outputChannel.appendLine(`cwd: ${workingDir}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, [filePath], {
      cwd: workingDir,
      env: process.env,
      shell: useShell,
      windowsHide: true,
      detached: false,
    });

    child.on("error", (error) => {
      outputChannel.appendLine("");
      outputChannel.appendLine(error.message);
      reject(error);
    });

    child.on("close", (code) => {
      outputChannel.appendLine("");
      if (code === 0 || code === null) {
        resolve();
        return;
      }

      reject(new Error(`KiCad exited with code ${code}`));
    });
  }).catch((error) => {
    vscode.window.showErrorMessage(error.message);
    return undefined;
  });
}

function normalizeOutput(chunk) {
  return String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

module.exports = {
  activate,
  deactivate,
};
