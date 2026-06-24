"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
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
    vscode.commands.registerCommand("schrune.openProject", () => openGeneratedKiCadProject(context))
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
    const index = await buildProjectIndex(document);

    if (contextKind === "include") {
      return buildIncludeCompletions(document, linePrefix, currentWord);
    }

    if (contextKind === "new") {
      return buildNamedSymbolCompletions(currentWord, [
        ...SCHRUNE_BUILTINS.map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Built-in part" })),
        ...[...index.parts.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Part definition" })),
        ...[...index.modules.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Module definition" })),
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
        ...[...index.nets].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Net" })),
        ...[...index.rails].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Rail" })),
        ...[...index.instances.keys()].map((name) => ({
          name,
          kind: vscode.CompletionItemKind.Reference,
          detail: "Part or module instance",
        })),
      ]);
      if (items.length) {
        return items;
      }
    }

    const memberCompletions = buildMemberAccessCompletions(linePrefix, currentWord, index);
    if (memberCompletions) {
      return memberCompletions;
    }

    return buildGeneralCompletions(currentWord, index);
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
      makeSectionItem("Parts"),
      makeActionItem("Add LCSC part...", "Download and scaffold a part library entry", "schrune.addPart"),
      makeSpacerItem(),
      makeSectionItem("Build"),
      makeActionItem("Build current file", "Run Schrune build for the active editor", "schrune.buildCurrentFile"),
      makeActionItem("Build file...", "Choose a .schrune file and build it", "schrune.buildFile"),
      makeSpacerItem(),
      makeSectionItem("KiCad"),
      makeActionItem("Open project in KiCad", "Open the generated KiCad project for the active design", "schrune.openProject"),
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

function makeSectionItem(label) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.contextValue = "schruneSection";
  item.description = "";
  return item;
}

function makeSpacerItem() {
  const item = new vscode.TreeItem(" ", vscode.TreeItemCollapsibleState.None);
  item.contextValue = "schruneSpacer";
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

function buildGeneralCompletions(prefix, index) {
  const normalizedPrefix = prefix.toLowerCase();
  const candidates = [
    ...SCHRUNE_KEYWORDS.map((name) => ({ name, kind: vscode.CompletionItemKind.Keyword, detail: "Schrune keyword" })),
    ...[...index.parts.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Part definition" })),
    ...[...index.modules.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "Module definition" })),
    ...[...index.nets.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Net" })),
    ...[...index.rails.keys()].map((name) => ({ name, kind: vscode.CompletionItemKind.Variable, detail: "Rail" })),
    ...[...index.instances.keys()].map((name) => ({
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

function buildMemberAccessCompletions(linePrefix, currentWord, index) {
  const memberMatch = linePrefix.match(/([A-Za-z_]\w*(?:\[[^\]]+\]|\.[A-Za-z_]\w*)*)\.$/);
  if (!memberMatch) {
    return undefined;
  }

  const expression = memberMatch[1];
  const typeInfo = resolveExpressionType(expression, index);
  if (!typeInfo) {
    return buildNamedSymbolCompletions(currentWord, buildFallbackMemberEntries(index));
  }

  return buildNamedSymbolCompletions(currentWord, typeInfo.members);
}

function buildFallbackMemberEntries(index) {
  const entries = [
    ...[...index.parts.values()].flatMap((part) => [...part.pins].map((name) => ({
      name,
      kind: vscode.CompletionItemKind.Field,
      detail: "Part pin",
    }))),
    ...[...index.modules.values()].flatMap((module) => [...module.nets].map((name) => ({
      name,
      kind: vscode.CompletionItemKind.Field,
      detail: "Module net",
    }))),
  ];
  return dedupeCompletionEntries(entries);
}

function resolveExpressionType(expression, index) {
  const baseMatch = expression.match(/^([A-Za-z_]\w*)/);
  if (!baseMatch) {
    return undefined;
  }

  const baseName = baseMatch[1];
  const tail = expression.slice(baseName.length);

  if (index.rails.has(baseName)) {
    return {
      kind: "rail",
      members: [
        { name: "h", kind: vscode.CompletionItemKind.Property, detail: "Rail high side" },
        { name: "l", kind: vscode.CompletionItemKind.Property, detail: "Rail low side" },
        { name: "name", kind: vscode.CompletionItemKind.Property, detail: "Rail name" },
        { name: "voltage", kind: vscode.CompletionItemKind.Property, detail: "Rail voltage" },
      ],
    };
  }

  const netEntry = index.nets.get(baseName);
  if (netEntry && netEntry.type) {
    return {
      kind: "typedNet",
      members: netTypeMembers(netEntry.type),
    };
  }

  const instance = index.instances.get(baseName);
  if (!instance) {
    return undefined;
  }

  if (instance.kind === "module") {
    const moduleDef = index.modules.get(instance.typeName);
    if (moduleDef) {
      return {
        kind: "moduleInstance",
        members: dedupeCompletionEntries([...moduleDef.nets].map((name) => ({
          name,
          kind: vscode.CompletionItemKind.Field,
          detail: "Module net",
        }))),
      };
    }
  }

  if (instance.kind === "part") {
    const partDef = index.parts.get(instance.typeName);
    if (partDef) {
      return {
        kind: "partInstance",
        members: [...partDef.pins].map((name) => ({
          name,
          kind: vscode.CompletionItemKind.Field,
          detail: "Part pin",
        })),
      };
    }
  }

  if (!tail || tail === ".h" || tail === ".l") {
    return undefined;
  }

  return {
    kind: "unknown",
    members: buildFallbackMemberEntries(index),
  };
}

async function buildProjectIndex(document) {
  const index = {
    parts: new Map(),
    modules: new Map(),
    nets: new Map(),
    rails: new Set(),
    instances: new Map(),
  };
  const visited = new Set();

  await collectProjectFile(document.uri.fsPath, document.getText(), index, visited, true);
  return index;
}

async function collectProjectFile(filePath, sourceText, index, visited, isRoot) {
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
  collectSourceDefinitions(normalizedSource, index);

  for (const includeName of extractIncludes(normalizedSource)) {
    const includePath = await resolveIncludePath(path.dirname(resolvedPath), includeName);
    if (includePath) {
      await collectProjectFile(includePath, undefined, index, visited, false);
    }
  }
}

function collectSourceDefinitions(source, index) {
  for (const block of extractNamedBlocks(source, "part", false)) {
    index.parts.set(block.name, {
      filePath: block.filePath,
      pins: parsePartPins(block.body),
    });
  }

  for (const block of extractNamedBlocks(source, "module", true)) {
    index.modules.set(block.name, {
      filePath: block.filePath,
      parameters: parseParameterList(block.parameters),
      nets: parseModuleNets(block.body),
    });
  }

  collectFlatDeclarations(source, index);
}

function collectFlatDeclarations(source, index) {
  const netPattern = /^\s*net(?:<([A-Za-z_]\w*)>)?\s+([A-Za-z_]\w*)/gm;
  const railPattern = /^\s*rail\s+([A-Za-z_]\w*)/gm;
  const moduleInstancePattern = /^\s*mod\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)/gm;
  const arrayPartPattern = /^\s*part\[\d+\]\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)/gm;
  const partInstancePattern = /^\s*(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)/gm;

  for (const match of source.matchAll(netPattern)) {
    index.nets.set(match[2], { type: match[1] ? normalizeNetType(match[1]) : undefined });
  }

  for (const match of source.matchAll(railPattern)) {
    index.rails.add(match[1]);
  }

  for (const match of source.matchAll(moduleInstancePattern)) {
    index.instances.set(match[1], { kind: "module", typeName: match[2] });
  }

  for (const match of source.matchAll(arrayPartPattern)) {
    index.instances.set(match[1], { kind: "part", typeName: match[2] });
  }

  for (const match of source.matchAll(partInstancePattern)) {
    const instanceName = match[1];
    const typeName = match[2];
    if (isDeclarationKeyword(instanceName)) {
      continue;
    }
    const kind = index.modules.has(typeName) ? "module" : "part";
    index.instances.set(instanceName, { kind, typeName });
  }
}

function isDeclarationKeyword(value) {
  return new Set(["module", "part", "net", "rail", "val", "mod", "if", "for", "return"]).has(value);
}

function extractNamedBlocks(source, keyword, allowParameters) {
  const blocks = [];
  const pattern = new RegExp(`\\b${keyword}\\s+([A-Za-z_]\\w*)${allowParameters ? "\\s*(\\([^)]*\\))?" : ""}\\s*\\{`, "g");
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const openIndex = source.indexOf("{", match.index);
    const closeIndex = findMatchingDelimiter(source, openIndex, "{", "}");
    blocks.push({
      name: match[1],
      parameters: match[2] ? match[2].slice(1, -1) : "",
      body: source.slice(openIndex + 1, closeIndex),
      filePath: undefined,
    });
    pattern.lastIndex = closeIndex + 1;
  }

  return blocks;
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    const prev = source[i - 1];

    if (inString) {
      if (char === stringChar && prev !== "\\") {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error(`Could not find matching ${closeChar}`);
}

function splitTopLevelEntries(body) {
  const entries = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i <= body.length; i++) {
    const char = body[i];
    const prev = body[i - 1];

    if (inString) {
      if (char === stringChar && prev !== "\\") {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === "[" || char === "{" || char === "(") {
      depth++;
    } else if (char === "]" || char === "}" || char === ")") {
      depth--;
    }

    if ((char === "," || char === "\n" || i === body.length) && depth === 0) {
      const entry = body.slice(start, i).trim().replace(/,$/, "");
      if (entry) {
        entries.push(entry);
      }
      start = i + 1;
    }
  }

  return entries;
}

function parsePartPins(body) {
  const pinsMatch = body.match(/\bpins\s*:\s*\[/);
  if (!pinsMatch) {
    return new Set();
  }

  const openIndex = body.indexOf("[", pinsMatch.index);
  const closeIndex = findMatchingDelimiter(body, openIndex, "[", "]");
  const pinsBody = body.slice(openIndex + 1, closeIndex);
  const pins = new Set();
  collectPinNames(pinsBody, pins);
  return pins;
}

function collectPinNames(body, pins, prefix = "") {
  for (const entry of splitTopLevelEntries(body)) {
    const objectMatch = entry.match(/^([A-Za-z_]\w*)\s*:\s*\{([\s\S]*)\}$/);
    if (objectMatch) {
      const name = prefix ? `${prefix}.${objectMatch[1]}` : objectMatch[1];
      pins.add(name);
      collectPinNames(objectMatch[2], pins, name);
      continue;
    }

    const arrayMatch = entry.match(/^([A-Za-z_]\w*)\s*:\s*\[([\s\S]*)\]$/);
    if (arrayMatch) {
      const name = prefix ? `${prefix}.${arrayMatch[1]}` : arrayMatch[1];
      pins.add(name);
      collectPinNames(arrayMatch[2], pins, name);
      continue;
    }

    const pinMatch = entry.match(/^([A-Za-z_]\w*|\d+)\s*:\s*.+$/);
    if (pinMatch) {
      const name = prefix ? `${prefix}.${pinMatch[1]}` : pinMatch[1];
      pins.add(name);
    }
  }
}

function parseModuleNets(body) {
  const nets = new Set();
  const netPattern = /^\s*net(?:<([A-Za-z_]\w*)>)?\s+([A-Za-z_]\w*)/gm;

  for (const match of body.matchAll(netPattern)) {
    nets.add(match[2]);
  }

  return nets;
}

function parseParameterList(parametersText) {
  if (!parametersText) {
    return [];
  }

  return splitTopLevelEntries(parametersText)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/=.*$/, "").trim())
    .filter((entry) => /^[A-Za-z_]\w*$/.test(entry));
}

function normalizeNetType(type) {
  return type ? String(type).trim() : undefined;
}

function netTypeMembers(type) {
  const memberMap = {
    i2c: ["SDA", "SCL"],
    uart: ["RX", "TX"],
    spi: ["MOSI", "MISO", "CLK"],
  };

  return (memberMap[type] || []).map((name) => ({
    name,
    kind: vscode.CompletionItemKind.Field,
    detail: `${type} signal`,
  }));
}

function dedupeCompletionEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry || !entry.name || seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    result.push(entry);
  }
  return result;
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

function resolveKiCadExecutable() {
  const configured = getKiCadConfig().executable;
  if (configured) {
    return configured;
  }

  const pathCandidates = [];
  if (process.platform === "win32") {
    const programFiles = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean);
    for (const root of programFiles) {
      const kicadRoot = path.join(root, "KiCad");
      if (!fs.existsSync(kicadRoot)) {
        continue;
      }

      for (const versionDir of safeReadDir(kicadRoot)) {
        pathCandidates.push(path.join(kicadRoot, versionDir, "bin", "kicad.exe"));
        pathCandidates.push(path.join(kicadRoot, versionDir, "bin", "kicad"));
      }
    }
  }

  pathCandidates.push("kicad", "kicad.exe");

  for (const candidate of pathCandidates) {
    if (isExecutableOnPath(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: false });
  } catch {
    return [];
  }
}

function isExecutableOnPath(command) {
  if (!command) {
    return false;
  }

  if (path.isAbsolute(command)) {
    return fs.existsSync(command);
  }

  const check = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(check, [command], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
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

async function openGeneratedKiCadProject(context) {
  const sourceFile = resolveActiveSchruneFile();
  if (!sourceFile) {
    vscode.window.showErrorMessage("Open a Schrune file first.");
    return;
  }

  const outputPath = getGeneratedKiCadProjectPath(sourceFile);
  if (!fs.existsSync(outputPath)) {
    vscode.window.showErrorMessage(`Missing generated KiCad project: ${outputPath}. Build the Schrune file first.`);
    return;
  }

  await runKiCad(context, outputPath, path.dirname(sourceFile));
}

function getGeneratedKiCadProjectPath(sourceFile) {
  const rootDir = path.dirname(sourceFile);
  const projectDir = path.join(rootDir, "KiCad");
  const stem = path.basename(sourceFile, ".schrune");
  const rootName = path.basename(rootDir);
  const candidates = listKiCadProjectFiles(projectDir);
  if (!candidates.length) {
    return path.join(projectDir, `${stem}.kicad_pro`);
  }

  const preferred = candidates.find((filePath) => {
    const base = path.basename(filePath, ".kicad_pro");
    return base === stem || base === rootName;
  });

  return preferred || candidates.sort((left, right) => left.localeCompare(right))[0];
}

function resolveActiveSchruneFile() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.toLowerCase().endsWith(".schrune")) {
    return editor.document.uri.fsPath;
  }
  return undefined;
}

function listKiCadProjectFiles(projectDir) {
  if (!fs.existsSync(projectDir)) {
    return [];
  }

  return fs
    .readdirSync(projectDir)
    .filter((entry) => entry.toLowerCase().endsWith(".kicad_pro"))
    .map((entry) => path.join(projectDir, entry));
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
  const command = resolveKiCadExecutable();
  if (!command) {
    vscode.window.showErrorMessage("Could not find KiCad. Set schrune.kicad.executable to your KiCad binary.");
    return;
  }

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
