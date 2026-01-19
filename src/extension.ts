import * as path from 'path';
import * as vscode from 'vscode';
import { Node, parseTree } from 'jsonc-parser';

type SchemaNode = {
    type?: string | string[];
    properties?: Record<string, SchemaNode>;
    required?: string[];
    items?: SchemaNode | SchemaNode[];
    additionalProperties?: boolean | SchemaNode;
    allOf?: SchemaNode[];
    oneOf?: SchemaNode[];
    anyOf?: SchemaNode[];
    $ref?: string;
    enum?: unknown[];
};

type SchemaMapping = {
    pattern: string;
    schemaPath: string;
};

type ExtensionConfig = {
    schemaMappings: SchemaMapping[];
    showUnknownProperties: boolean;
    enableDiagnostics: boolean;
};

type CachedSchema = {
    mtime: number;
    schema: SchemaNode;
};

const schemaCache = new Map<string, CachedSchema>();

function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('jsonSchemaHelper');
    return {
        schemaMappings: config.get<SchemaMapping[]>('schemaMappings', []),
        showUnknownProperties: config.get<boolean>('showUnknownProperties', true),
        enableDiagnostics: config.get<boolean>('enableDiagnostics', true)
    };
}

async function resolveSchemaUriForDocument(
    document: vscode.TextDocument,
    root: Node
): Promise<vscode.Uri | undefined> {
    const config = getConfig();
    const mappingPath = findSchemaMapping(document, config.schemaMappings);
    const schemaId = mappingPath ?? findTopLevelSchemaId(root);
    if (!schemaId) {
        return undefined;
    }

    if (mappingPath) {
        return resolveSchemaUri(document, schemaId, 'workspace');
    }

    return resolveSchemaUri(document, schemaId, 'document');
}

function findSchemaMapping(document: vscode.TextDocument, mappings: SchemaMapping[]): string | undefined {
    if (mappings.length === 0) {
        return undefined;
    }

    const relativePath = toPosixPath(vscode.workspace.asRelativePath(document.uri, false));
    for (const mapping of mappings) {
        if (!mapping.pattern || !mapping.schemaPath) {
            continue;
        }

        const pattern = normalizePattern(mapping.pattern);
        if (matchesPattern(relativePath, pattern)) {
            return mapping.schemaPath;
        }
    }

    return undefined;
}

function normalizePattern(pattern: string): string {
    if (pattern.includes('/')) {
        return pattern;
    }

    return `**/${pattern}`;
}

function matchesPattern(target: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = escaped
        .replace(/\\\*\\\*/g, '.*')
        .replace(/\\\*/g, '[^/]*')
        .replace(/\\\?/g, '.');

    return new RegExp(`^${regex}$`).test(target);
}

function toPosixPath(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
}

function findTopLevelSchemaId(root: Node): string | undefined {
    if (root.type !== 'object' || !root.children) {
        return undefined;
    }

    for (const propertyNode of root.children) {
        if (propertyNode.type !== 'property' || !propertyNode.children || propertyNode.children.length < 2) {
            continue;
        }

        const keyNode = propertyNode.children[0];
        const valueNode = propertyNode.children[1];
        const key = typeof keyNode.value === 'string' ? keyNode.value : undefined;
        if (key === '$schema' && valueNode.type === 'string' && typeof valueNode.value === 'string') {
            return valueNode.value;
        }
    }

    return undefined;
}

function resolveSchemaUri(
    document: vscode.TextDocument,
    schemaId: string,
    base: 'workspace' | 'document'
): vscode.Uri | undefined {
    if (schemaId.startsWith('file://')) {
        return vscode.Uri.parse(schemaId);
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(schemaId)) {
        return undefined;
    }

    if (path.isAbsolute(schemaId)) {
        return vscode.Uri.file(schemaId);
    }

    if (base === 'document') {
        const documentDir = path.dirname(document.uri.fsPath);
        return vscode.Uri.file(path.join(documentDir, schemaId));
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        return undefined;
    }

    return vscode.Uri.joinPath(workspaceFolder.uri, schemaId);
}

async function loadSchema(uri: vscode.Uri): Promise<SchemaNode | undefined> {
    const cacheKey = uri.toString();

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        const cached = schemaCache.get(cacheKey);
        if (cached && cached.mtime === stat.mtime) {
            return cached.schema;
        }

        const data = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(data).toString('utf8');
        const schema = JSON.parse(text) as SchemaNode;
        schemaCache.set(cacheKey, { mtime: stat.mtime, schema });
        return schema;
    } catch (error) {
        console.warn(`JSON Schema Helper: Unable to load schema ${cacheKey}`, error);
        return undefined;
    }
}

type PropertySchemaInfo = {
    schema?: SchemaNode;
    isKnown: boolean;
};

function getPropertySchemaInfo(
    schema: SchemaNode,
    key: string
): PropertySchemaInfo {
    if (schema.properties && schema.properties[key]) {
        return {
            schema: schema.properties[key],
            isKnown: true
        };
    }

    if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
        return {
            schema: undefined,
            isKnown: false
        };
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return {
            schema: schema.additionalProperties as SchemaNode,
            isKnown: true
        };
    }

    return { schema: undefined, isKnown: false };
}

function resolveArrayItemSchema(
    items: SchemaNode | SchemaNode[] | undefined,
    index: number
): SchemaNode | undefined {
    if (!items) {
        return undefined;
    }

    if (Array.isArray(items)) {
        return items[index] ?? items[items.length - 1];
    }

    return items;
}

function isObjectSchema(schema: SchemaNode): boolean {
    const types = toTypeArray(schema.type);
    return types.includes('object') || !!schema.properties;
}

function isArraySchema(schema: SchemaNode): boolean {
    const types = toTypeArray(schema.type);
    return types.includes('array') || !!schema.items;
}

function toTypeArray(type: string | string[] | undefined): string[] {
    if (!type) {
        return [];
    }

    return Array.isArray(type) ? type : [type];
}

function resolveSchemaNode(
    schema: SchemaNode | undefined,
    rootSchema: SchemaNode,
    seen: Set<SchemaNode> = new Set()
): SchemaNode | undefined {
    if (!schema) {
        return undefined;
    }

    if (schema.$ref && typeof schema.$ref === 'string') {
        if (!schema.$ref.startsWith('#')) {
            return undefined;
        }

        const resolved = resolvePointer(rootSchema, schema.$ref);
        if (!resolved || seen.has(resolved)) {
            return resolved;
        }

        seen.add(resolved);
        return resolveSchemaNode(resolved, rootSchema, seen);
    }

    if (schema.allOf && schema.allOf.length > 0) {
        return mergeSchemas(schema.allOf.map(entry => resolveSchemaNode(entry, rootSchema)).filter(Boolean) as SchemaNode[]);
    }

    if (schema.oneOf && schema.oneOf.length > 0) {
        return resolveSchemaNode(schema.oneOf[0], rootSchema, seen);
    }

    if (schema.anyOf && schema.anyOf.length > 0) {
        return resolveSchemaNode(schema.anyOf[0], rootSchema, seen);
    }

    return schema;
}

function resolvePointer(rootSchema: SchemaNode, ref: string): SchemaNode | undefined {
    if (!ref.startsWith('#/')) {
        return undefined;
    }

    const parts = ref
        .slice(2)
        .split('/')
        .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));

    let current: unknown = rootSchema;
    for (const part of parts) {
        if (!current || typeof current !== 'object') {
            return undefined;
        }

        const record = current as Record<string, unknown>;
        if (!(part in record)) {
            return undefined;
        }

        current = record[part];
    }

    return current as SchemaNode;
}

function mergeSchemas(schemas: SchemaNode[]): SchemaNode | undefined {
    if (schemas.length === 0) {
        return undefined;
    }

    const merged: SchemaNode = {};
    for (const schema of schemas) {
        if (!schema) {
            continue;
        }

        if (schema.type) {
            merged.type = schema.type;
        }

        if (schema.properties) {
            merged.properties = { ...merged.properties, ...schema.properties };
        }

        if (schema.required) {
            const required = new Set([...(merged.required ?? []), ...schema.required]);
            merged.required = Array.from(required);
        }

        if (schema.items) {
            merged.items = schema.items;
        }

        if (schema.additionalProperties !== undefined) {
            merged.additionalProperties = schema.additionalProperties;
        }
    }

    return merged;
}

export function activate(context: vscode.ExtensionContext) {
    const diagnostics = vscode.languages.createDiagnosticCollection('jsonSchemaHelper');

    context.subscriptions.push(
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(document => {
            void updateDiagnosticsForDocument(document, diagnostics);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            void updateDiagnosticsForDocument(event.document, diagnostics);
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            const key = document.uri.toString();
            const schemaInvalidated = schemaCache.delete(key);
            if (schemaInvalidated) {
                for (const openDocument of vscode.workspace.textDocuments) {
                    void updateDiagnosticsForDocument(openDocument, diagnostics);
                }
            } else {
                void updateDiagnosticsForDocument(document, diagnostics);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnostics.delete(document.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('jsonSchemaHelper')) {
                schemaCache.clear();
                for (const document of vscode.workspace.textDocuments) {
                    void updateDiagnosticsForDocument(document, diagnostics);
                }
            }
        })
    );

    for (const document of vscode.workspace.textDocuments) {
        void updateDiagnosticsForDocument(document, diagnostics);
    }
}

export function deactivate() {}

async function updateDiagnosticsForDocument(
    document: vscode.TextDocument,
    diagnostics: vscode.DiagnosticCollection
): Promise<void> {
    if (!isJsonDocument(document)) {
        diagnostics.delete(document.uri);
        return;
    }

    const config = getConfig();
    if (!config.enableDiagnostics) {
        diagnostics.delete(document.uri);
        return;
    }

    const text = document.getText();
    const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    if (!root) {
        diagnostics.delete(document.uri);
        return;
    }

    const schemaUri = await resolveSchemaUriForDocument(document, root);
    if (!schemaUri) {
        diagnostics.delete(document.uri);
        return;
    }

    const schema = await loadSchema(schemaUri);
    if (!schema) {
        diagnostics.delete(document.uri);
        return;
    }

    const results = collectDiagnostics(root, schema, document, config);
    diagnostics.set(document.uri, results);
}

function isJsonDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'json' || document.languageId === 'jsonc';
}

function collectDiagnostics(
    root: Node,
    schema: SchemaNode,
    document: vscode.TextDocument,
    config: ExtensionConfig
): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const resolvedRoot = resolveSchemaNode(schema, schema);
    if (!resolvedRoot) {
        return diagnostics;
    }

    visitNodeForDiagnostics(root, resolvedRoot, schema, document, diagnostics, config);
    return diagnostics;
}

function visitNodeForDiagnostics(
    node: Node,
    schema: SchemaNode | undefined,
    rootSchema: SchemaNode,
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[],
    config: ExtensionConfig
): void {
    if (!schema) {
        return;
    }

    const resolvedSchema = resolveSchemaNode(schema, rootSchema);
    if (!resolvedSchema) {
        return;
    }

    if (!isNodeTypeCompatible(node, resolvedSchema)) {
        diagnostics.push(createTypeMismatchDiagnostic(node, resolvedSchema, document));
        return;
    }

    if (node.type === 'object') {
        if (!isObjectSchema(resolvedSchema)) {
            return;
        }

        const requiredSet = new Set((resolvedSchema.required ?? []).map(item => String(item)));
        const presentKeys = new Set<string>();

        for (const propertyNode of node.children ?? []) {
            if (propertyNode.type !== 'property' || !propertyNode.children || propertyNode.children.length < 2) {
                continue;
            }

            const keyNode = propertyNode.children[0];
            const valueNode = propertyNode.children[1];
            const key = typeof keyNode.value === 'string' ? keyNode.value : undefined;
            if (!key) {
                continue;
            }
            if (key === '$schema') {
                continue;
            }

            presentKeys.add(key);

            const info = getPropertySchemaInfo(resolvedSchema, key);
            if (info.schema) {
                visitNodeForDiagnostics(valueNode, info.schema, rootSchema, document, diagnostics, config);
            } else if (config.showUnknownProperties && !info.isKnown) {
                diagnostics.push(createUnknownPropertyDiagnostic(keyNode, key, document));
            }
        }

        for (const requiredKey of requiredSet) {
            if (requiredKey === '$schema') {
                continue;
            }
            if (!presentKeys.has(requiredKey)) {
                diagnostics.push(createMissingRequiredDiagnostic(node, requiredKey, document));
            }
        }

        return;
    }

    if (node.type === 'array') {
        if (!isArraySchema(resolvedSchema) || !node.children) {
            return;
        }

        const items = resolvedSchema.items;
        for (let index = 0; index < node.children.length; index++) {
            const element = node.children[index];
            const itemSchema = resolveArrayItemSchema(items, index);
            if (itemSchema) {
                visitNodeForDiagnostics(element, itemSchema, rootSchema, document, diagnostics, config);
            }
        }
    }
}

function isNodeTypeCompatible(node: Node, schema: SchemaNode): boolean {
    const expected = getSchemaTypeCandidates(schema);
    if (expected.length === 0) {
        return true;
    }

    switch (node.type) {
        case 'string':
            return expected.includes('string');
        case 'number': {
            if (expected.includes('number')) {
                return true;
            }
            if (expected.includes('integer')) {
                return typeof node.value === 'number' && Number.isInteger(node.value);
            }
            return false;
        }
        case 'boolean':
            return expected.includes('boolean');
        case 'null':
            return expected.includes('null');
        case 'object':
            return expected.includes('object');
        case 'array':
            return expected.includes('array');
        default:
            return true;
    }
}

function getSchemaTypeCandidates(schema: SchemaNode): string[] {
    let types = toTypeArray(schema.type);
    if (types.length === 0) {
        if (schema.properties || schema.required) {
            types = ['object'];
        } else if (schema.items) {
            types = ['array'];
        }
    }

    return types;
}

function createUnknownPropertyDiagnostic(
    keyNode: Node,
    key: string,
    document: vscode.TextDocument
): vscode.Diagnostic {
    const range = toRange(document, keyNode.offset, keyNode.offset + keyNode.length);
    return new vscode.Diagnostic(
        range,
        `Unknown property "${key}" (not in schema).`,
        vscode.DiagnosticSeverity.Warning
    );
}

function createMissingRequiredDiagnostic(
    objectNode: Node,
    key: string,
    document: vscode.TextDocument
): vscode.Diagnostic {
    const start = objectNode.offset;
    const range = toRange(document, start, start + 1);
    return new vscode.Diagnostic(
        range,
        `Missing required property "${key}".`,
        vscode.DiagnosticSeverity.Warning
    );
}

function createTypeMismatchDiagnostic(
    node: Node,
    schema: SchemaNode,
    document: vscode.TextDocument
): vscode.Diagnostic {
    const range = toRange(document, node.offset, node.offset + node.length);
    const expected = getSchemaTypeCandidates(schema);
    const expectedLabel = expected.length > 0 ? expected.join(' | ') : 'unknown';
    return new vscode.Diagnostic(
        range,
        `Type mismatch: expected ${expectedLabel}.`,
        vscode.DiagnosticSeverity.Warning
    );
}

function toRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
    const startPos = document.positionAt(start);
    const endPos = document.positionAt(end);
    return new vscode.Range(startPos, endPos);
}
