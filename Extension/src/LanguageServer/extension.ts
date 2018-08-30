/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as util from '../common';
import * as telemetry from '../telemetry';
import { UI, getUI } from './ui';
import { Client } from './client';
import { ClientCollection } from './clientCollection';
import { CppSettings } from './settings';
import { PersistentWorkspaceState } from './persistentState';
import { getLanguageConfig } from './languageConfig';
import { getCustomConfigProviders } from './customProviders';
import { SettingsTracker, getTracker } from './settingsTracker';
import { PlatformInformation } from '../platform';
import * as url from 'url';
import * as https from 'https';
import { ClientRequest, OutgoingHttpHeaders } from 'http';
import { exec } from 'child_process';

let prevCrashFile: string;
let clients: ClientCollection;
let activeDocument: string;
let ui: UI;
let disposables: vscode.Disposable[] = [];
let languageConfigurations: vscode.Disposable[] = [];
let intervalTimer: NodeJS.Timer;
let insiderUpdateTimer: NodeJS.Timer;
let realActivationOccurred: boolean = false;
let tempCommands: vscode.Disposable[] = [];
let activatedPreviously: PersistentWorkspaceState<boolean>;
const insiderUpdateTimerInterval: number = 1000 * 15;

/**
 * activate: set up the extension for language services
 */
export function activate(activationEventOccurred: boolean): void {
    console.log("activating extension");

    // Activate immediately if an activation event occurred in the previous workspace session.
    // If onActivationEvent doesn't occur, it won't auto-activate next time.
    activatedPreviously = new PersistentWorkspaceState("activatedPreviously", false);
    if (activatedPreviously.Value) {
        activatedPreviously.Value = false;
        realActivation();
    }

    registerCommands();
    tempCommands.push(vscode.workspace.onDidOpenTextDocument(d => onDidOpenTextDocument(d)));

    // Check if an activation event has already occurred.
    if (activationEventOccurred) {
        onActivationEvent();
        return;
    }

    // handle "workspaceContains:/.vscode/c_cpp_properties.json" activation event.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        for (let i: number = 0; i < vscode.workspace.workspaceFolders.length; ++i) {
            let config: string = path.join(vscode.workspace.workspaceFolders[i].uri.fsPath, ".vscode/c_cpp_properties.json");
            if (fs.existsSync(config)) {
                onActivationEvent();
                return;
            }
        }
    }

    // handle "onLanguage:cpp" and "onLanguage:c" activation events.
    if (vscode.workspace.textDocuments !== undefined && vscode.workspace.textDocuments.length > 0) {
        for (let i: number = 0; i < vscode.workspace.textDocuments.length; ++i) {
            let document: vscode.TextDocument = vscode.workspace.textDocuments[i];
            if (document.languageId === "cpp" || document.languageId === "c") {
                onActivationEvent();
                return;
            }
        }
    }
}

function onDidOpenTextDocument(document: vscode.TextDocument): void {
    if (document.languageId === "c" || document.languageId === "cpp") {
        onActivationEvent();
    }
}

function onActivationEvent(): void {
    if (tempCommands.length === 0) {
        return;
    }

    // Cancel all the temp commands that just look for activations.
    tempCommands.forEach((command) => {
        command.dispose();
    });
    tempCommands = [];
    if (!realActivationOccurred) {
        realActivation();
    }
    activatedPreviously.Value = true;
}

function realActivation(): void {
    realActivationOccurred = true;
    console.log("starting language server");
    clients = new ClientCollection();
    ui = getUI();

    // Check for files left open from the previous session. We won't get events for these until they gain focus,
    // so we manually activate the visible file.
    if (vscode.workspace.textDocuments !== undefined && vscode.workspace.textDocuments.length > 0) {
        onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
    }

    // There may have already been registered CustomConfigurationProviders.
    // Request for configurations from those providers.
    clients.forEach(client => {
        getCustomConfigProviders().forEach(provider => client.onRegisterCustomConfigurationProvider(provider));
    });

    disposables.push(vscode.workspace.onDidChangeConfiguration(onDidChangeSettings));
    disposables.push(vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument));
    disposables.push(vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor));
    disposables.push(vscode.window.onDidChangeTextEditorSelection(onDidChangeTextEditorSelection));
    disposables.push(vscode.window.onDidChangeVisibleTextEditors(onDidChangeVisibleTextEditors));

    updateLanguageConfigurations();

    reportMacCrashes();

    // insiderUpdateTimer = setInterval(checkAndApplyUpdate, insiderUpdateTimerInterval);
    intervalTimer = setInterval(onInterval, 2500);
}

export function updateLanguageConfigurations(): void {
    languageConfigurations.forEach(d => d.dispose());
    languageConfigurations = [];

    languageConfigurations.push(vscode.languages.setLanguageConfiguration('c', getLanguageConfig('c', clients.ActiveClient.RootUri)));
    languageConfigurations.push(vscode.languages.setLanguageConfiguration('cpp', getLanguageConfig('cpp', clients.ActiveClient.RootUri)));
}

/*********************************************
 * workspace events
 *********************************************/

function onDidChangeSettings(): void {
    // Check whether the user changed updateChannel to "Insiders", else return
    let tracker: SettingsTracker = clients.ActiveClient.SettingsTracker;
    let newUpdateChannel: string = tracker.getChangedSettings()["updateChannel"];

    clients.forEach(client => client.onDidChangeSettings());

    if (!newUpdateChannel) {
        return;
    }
    if (newUpdateChannel === "Default") {
        clearInterval(insiderUpdateTimer);
        return;
    }

     // insiderUpdateTimer = setInterval(checkAndApplyUpdate, insiderUpdateTimerInterval);
    checkAndApplyUpdate();
}

let saveMessageShown: boolean = false;
function onDidSaveTextDocument(doc: vscode.TextDocument): void {
    if (!vscode.window.activeTextEditor || doc !== vscode.window.activeTextEditor.document || (doc.languageId !== "cpp" && doc.languageId !== "c")) {
        return;
    }

    if (!saveMessageShown && new CppSettings(doc.uri).clangFormatOnSave) {
        saveMessageShown = true;
        vscode.window.showInformationMessage("\"C_Cpp.clang_format_formatOnSave\" has been removed. Please use \"editor.formatOnSave\" instead.");
    }
}

function onDidChangeActiveTextEditor(editor: vscode.TextEditor): void {
    /* need to notify the affected client(s) */
    console.assert(clients !== undefined, "client should be available before active editor is changed");
    if (clients === undefined) {
        return;
    }

    let activeEditor: vscode.TextEditor = vscode.window.activeTextEditor;
    if (!activeEditor || (activeEditor.document.languageId !== "cpp" && activeEditor.document.languageId !== "c")) {
        activeDocument = "";
    } else {
        activeDocument = editor.document.uri.toString();
        clients.activeDocumentChanged(editor.document);
        clients.ActiveClient.selectionChanged(editor.selection.start);
    }
    ui.activeDocumentChanged();
}

function onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    /* need to notify the affected client(s) */
    if (!event.textEditor || !vscode.window.activeTextEditor || event.textEditor.document.uri !== vscode.window.activeTextEditor.document.uri ||
        (event.textEditor.document.languageId !== "cpp" && event.textEditor.document.languageId !== "c")) {
        return;
    }

    if (activeDocument !== event.textEditor.document.uri.toString()) {
        // For some strange (buggy?) reason we don't reliably get onDidChangeActiveTextEditor callbacks.
        activeDocument = event.textEditor.document.uri.toString();
        clients.activeDocumentChanged(event.textEditor.document);
        ui.activeDocumentChanged();
    }
    clients.ActiveClient.selectionChanged(event.selections[0].start);
}

function onDidChangeVisibleTextEditors(editors: vscode.TextEditor[]): void {
    clients.forEach(client => client.onDidChangeVisibleTextEditors(editors));
}

// TODO move this fn to a common area -- Replace abTesting's downloadCpptoolsJsonAsync with this fn
function downloadFileToDestination(urlStr: string, destinationPath: string, headers?: OutgoingHttpHeaders): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let parsedUrl: url.Url = url.parse(urlStr);
        let request: ClientRequest = https.request({
            host: parsedUrl.host,
            path: parsedUrl.path,
            agent: util.getHttpsProxyAgent(),
            rejectUnauthorized: vscode.workspace.getConfiguration().get("http.proxyStrictSSL", true),
            headers: headers
        }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) { // If redirected
                // Download from new location
                let redirectUrl: string;
                if (typeof response.headers.location === "string") {
                    redirectUrl = response.headers.location;
                } else {
                    redirectUrl = response.headers.location[0];
                }
                return resolve(downloadFileToDestination(redirectUrl, destinationPath));
            }
            if (response.statusCode !== 200) { // If request is not successful
                return reject();
            }
            // Write file using downloaded data
            let downloadedBytes = 0; // tslint:disable-line
            let createdFile: fs.WriteStream = fs.createWriteStream(destinationPath);
            response.on('data', (data) => { downloadedBytes += data.length; });
            response.on('end', () => { createdFile.close(); });
            createdFile.on('close', () => { resolve(); this.updateSettingsAsync(); });
            response.on('error', (error) => { reject(); });
            response.pipe(createdFile, { end: false });
        });
        request.on('error', (error) => { reject(); });
        request.end();
    });
}

// TODO factor this out?
async function parseJsonAtPath(path: string): Promise<any> {
    try {
        const exists: boolean = await util.checkFileExists(path);
        if (exists) {
            const fileContent: string = await util.readFileText(path);
            return JSON.parse(fileContent);
        }
    } catch (error) {
        console.log(error);
    }
}

async function checkAndApplyUpdate(): Promise<void> {
    // Get current version name, stripping out everything past (and incl.) the dash if present
    // Return if the user is using a non-Release or non-Insider build (e.g. version ending in "-master")
    const version: string = function(): string {
        let version: string = util.packageJson["version"];
        const dashOffset: number = version.indexOf("-");
        if (dashOffset !== -1) {
            if (version.substr(dashOffset + 1) !== "insiders") {
                return null;
            }
            version = version.substr(0, dashOffset); // Strip out the suffix
        }
        return version;
    }();
    if (!version) {
        return;
    }

    // Download and parse the JSON release list from GitHub to get the latest build
    const releaseJsonPath: string = util.getExtensionFilePath("releases.json");
    await downloadFileToDestination("https://api.github.com/repos/Microsoft/vscode-cpptools/releases",
                                    releaseJsonPath, { "User-Agent": "vscode-cpptools" });
    const parsedJson: any = await parseJsonAtPath(releaseJsonPath);
    const latestBuild: any = parsedJson[0]; // [0] to get latest build
    if (!latestBuild) {
        return;
    }

    // Check whether the user actually needs to update
    if (version >= latestBuild["name"]) { // latestBuild["name"] excludes version suffix
        return;
    }

    // Get the VSIX name to search for in latestBuild
    // TODO resolve vsixName for mac + win
    const platformInfo: PlatformInformation = await PlatformInformation.GetPlatformInformation();
    const vsixName: string = function(platformInfo): string {
        let vsixName: string;
        if (platformInfo.platform === "linux") {
            if (platformInfo.architecture === "x86_64") {
                vsixName = "cpptools-linux.vsix";
            } else 
            if (platformInfo.architecture === "x86") {
                vsixName = "cpptools-linux32.vsix";
            }
        }
        return vsixName;
    }(platformInfo);
    if (!vsixName) {
        return;
    }
    
    // Get the URL to download the VSIX, using vsixName as a key
    const downloadUrl: string = latestBuild["assets"].find((asset) => {
        return asset["name"] === vsixName;
    })["browser_download_url"];
    if (!downloadUrl) {
        return;
    }

    // Download the latest version
    const vsixPath: string = util.getExtensionFilePath(vsixName);
    await downloadFileToDestination(downloadUrl, vsixPath);

    // Get the path to the VSCode command
    const vsCodeCommandFile: string = function(platformInfo): string {
        const vscodeProcessPath: string = path.dirname(process.execPath);
        let vsCodeCommandFile: string;
        if (platformInfo.platform === "windows") { // TODO get actual platform name for Windows
            vsCodeCommandFile = path.join(vscodeProcessPath, "bin", "code.cmd");
        } else {
            vsCodeCommandFile = vscodeProcessPath;
        }
        return vsCodeCommandFile;
    }(platformInfo);
    if (!vsCodeCommandFile) {
        return;
    }

    // Install the update
    const command: string = vsCodeCommandFile + " --install-extension " + vsixPath;
    exec(command);
    // TODO clean up temp files: releaseJson and the downloaded VSIX
}

function onInterval(): void {
    // TODO: do we need to pump messages to all clients? depends on what we do with the icons, I suppose.
    clients.ActiveClient.onInterval();
}

/*********************************************
 * registered commands
 *********************************************/

function registerCommands(): void {
    disposables.push(vscode.commands.registerCommand('C_Cpp.Navigate', onNavigate));
    disposables.push(vscode.commands.registerCommand('C_Cpp.GoToDeclaration', onGoToDeclaration));
    disposables.push(vscode.commands.registerCommand('C_Cpp.PeekDeclaration', onPeekDeclaration));
    disposables.push(vscode.commands.registerCommand('C_Cpp.SwitchHeaderSource', onSwitchHeaderSource));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ResetDatabase', onResetDatabase));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ConfigurationSelect', onSelectConfiguration));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ConfigurationProviderSelect', onSelectConfigurationProvider));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ConfigurationEdit', onEditConfiguration));
    disposables.push(vscode.commands.registerCommand('C_Cpp.AddToIncludePath', onAddToIncludePath));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ToggleErrorSquiggles', onToggleSquiggles));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ToggleSnippets', onToggleSnippets));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ToggleIncludeFallback', onToggleIncludeFallback));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ToggleDimInactiveRegions', onToggleDimInactiveRegions));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ShowReleaseNotes', onShowReleaseNotes));
    disposables.push(vscode.commands.registerCommand('C_Cpp.PauseParsing', onPauseParsing));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ResumeParsing', onResumeParsing));
    disposables.push(vscode.commands.registerCommand('C_Cpp.ShowParsingCommands', onShowParsingCommands));
    disposables.push(vscode.commands.registerCommand('C_Cpp.TakeSurvey', onTakeSurvey));
}

function onNavigate(): void {
    onActivationEvent();
    let activeEditor: vscode.TextEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }

    clients.ActiveClient.requestNavigationList(activeEditor.document).then((navigationList: string) => {
        ui.showNavigationOptions(navigationList);
    });
}

function onGoToDeclaration(): void {
    onActivationEvent();
    clients.ActiveClient.requestGoToDeclaration().then(() => vscode.commands.executeCommand("editor.action.goToDeclaration"));
}

function onPeekDeclaration(): void {
    onActivationEvent();
    clients.ActiveClient.requestGoToDeclaration().then(() => vscode.commands.executeCommand("editor.action.previewDeclaration"));
}

function onSwitchHeaderSource(): void {
    onActivationEvent();
    let activeEditor: vscode.TextEditor = vscode.window.activeTextEditor;
    if (!activeEditor || !activeEditor.document) {
        return;
    }

    if (activeEditor.document.languageId !== "cpp" && activeEditor.document.languageId !== "c") {
        return;
    }

    let rootPath: string = clients.ActiveClient.RootPath;
    let fileName: string = activeEditor.document.fileName;

    if (!rootPath) {
        rootPath = path.dirname(fileName); // When switching without a folder open.
    }

    clients.ActiveClient.requestSwitchHeaderSource(rootPath, fileName).then((targetFileName: string) => {
        vscode.workspace.openTextDocument(targetFileName).then((document: vscode.TextDocument) => {
            let foundEditor: boolean = false;
            // If the document is already visible in another column, open it there.
            vscode.window.visibleTextEditors.forEach((editor, index, array) => {
                if (editor.document === document && !foundEditor) {
                    foundEditor = true;
                    vscode.window.showTextDocument(document, editor.viewColumn);
                }
            });
            // TODO: Handle non-visibleTextEditor...not sure how yet.
            if (!foundEditor) {
                if (vscode.window.activeTextEditor !== undefined) {
                    // TODO: Change to show it in a different column?
                    vscode.window.showTextDocument(document, vscode.window.activeTextEditor.viewColumn);
                } else {
                    vscode.window.showTextDocument(document);
                }
            }
        });
    });
}

/**
 * Allow the user to select a workspace when multiple workspaces exist and get the corresponding Client back.
 * The resulting client is used to handle some command that was previously invoked.
 */
function selectClient(): Thenable<Client> {
    if (clients.Count === 1) {
        return Promise.resolve(clients.ActiveClient);
    } else {
        return ui.showWorkspaces(clients.Names).then(key => {
            if (key !== "") {
                let client: Client = clients.get(key);
                if (client) {
                    return client;
                } else {
                    console.assert("client not found");
                }
            }
            return Promise.reject<Client>("client not found");
        });
    }
}

function onResetDatabase(): void {
    onActivationEvent();
    /* need to notify the affected client(s) */
    selectClient().then(client => client.resetDatabase(), rejected => {});
}

function onSelectConfiguration(): void {
    onActivationEvent();
    if (!isFolderOpen()) {
        vscode.window.showInformationMessage('Open a folder first to select a configuration');
    } else {
        // This only applies to the active client. You cannot change the configuration for
        // a client that is not active since that client's UI will not be visible.
        clients.ActiveClient.handleConfigurationSelectCommand();
    }
}

function onSelectConfigurationProvider(): void {
    onActivationEvent();
    if (!isFolderOpen()) {
        vscode.window.showInformationMessage('Open a folder first to select a configuration provider');
    } else {
        selectClient().then(client => client.handleConfigurationProviderSelectCommand(), rejected => {});
    }
}

function onEditConfiguration(): void {
    onActivationEvent();
    if (!isFolderOpen()) {
        vscode.window.showInformationMessage('Open a folder first to edit configurations');
    } else {
        selectClient().then(client => client.handleConfigurationEditCommand(), rejected => {});
    }
}

function onAddToIncludePath(path: string): void {
    if (!isFolderOpen()) {
        vscode.window.showInformationMessage('Open a folder first to add to includePath');
    } else {
        // This only applies to the active client. It would not make sense to add the include path
        // suggestion to a different workspace.
        clients.ActiveClient.handleAddToIncludePathCommand(path);
    }
}

function onToggleSquiggles(): void {
    onActivationEvent();
    // This only applies to the active client.
    let settings: CppSettings = new CppSettings(clients.ActiveClient.RootUri);
    settings.toggleSetting("errorSquiggles", "Enabled", "Disabled");
}

function onToggleSnippets(): void {
    onActivationEvent();

    // This will apply to all clients as it's a global toggle. It will require a reload.
    const snippetsCatName: string  = "Snippets";
    let newPackageJson: any = util.getRawPackageJson();

    if (newPackageJson.categories.findIndex(cat => cat === snippetsCatName) === -1) {
        // Add the Snippet category and snippets node. 

        newPackageJson.categories.push(snippetsCatName);
        newPackageJson.contributes.snippets = [{"language": "cpp", "path": "./cpp_snippets.json"}, {"language": "c", "path": "./cpp_snippets.json"}];

        fs.writeFile(util.getPackageJsonPath(), util.stringifyPackageJson(newPackageJson), () => {
            showReloadPrompt("Reload Window to finish enabling C++ snippets");
        });
        
    } else {
        // Remove the category and snippets node.
        let ndxCat: number = newPackageJson.categories.indexOf(snippetsCatName);
        if (ndxCat !== -1) {
            newPackageJson.categories.splice(ndxCat, 1);
        }

        delete newPackageJson.contributes.snippets;

        fs.writeFile(util.getPackageJsonPath(), util.stringifyPackageJson(newPackageJson), () => {
            showReloadPrompt("Reload Window to finish disabling C++ snippets");
        });
    }
}

function showReloadPrompt(msg: string): void { 
    let reload: string = "Reload"; 
    vscode.window.showInformationMessage(msg, reload).then(value => { 
       if (value === reload) { 
          vscode.commands.executeCommand("workbench.action.reloadWindow"); 
       } 
    }); 
 } 

function onToggleIncludeFallback(): void {
    onActivationEvent();
    // This only applies to the active client.
    let settings: CppSettings = new CppSettings(clients.ActiveClient.RootUri);
    settings.toggleSetting("intelliSenseEngineFallback", "Enabled", "Disabled");
}

function onToggleDimInactiveRegions(): void {
    onActivationEvent();
    // This only applies to the active client.
    let settings: CppSettings = new CppSettings(clients.ActiveClient.RootUri);
    settings.update<boolean>("dimInactiveRegions", !settings.dimInactiveRegions);
}

function onShowReleaseNotes(): void {
    onActivationEvent();
    util.showReleaseNotes();
}

function onPauseParsing(): void {
    onActivationEvent();
    selectClient().then(client => client.pauseParsing(), rejected => {});
}

function onResumeParsing(): void {
    onActivationEvent();
    selectClient().then(client => client.resumeParsing(), rejected => {});
}

function onShowParsingCommands(): void {
    onActivationEvent();
    selectClient().then(client => client.handleShowParsingCommands(), rejected => {});
}

function onTakeSurvey(): void {
    onActivationEvent();
    telemetry.logLanguageServerEvent("onTakeSurvey");
    let uri: vscode.Uri = vscode.Uri.parse(`https://www.research.net/r/VBVV6C6?o=${os.platform()}&m=${vscode.env.machineId}`);
    vscode.commands.executeCommand('vscode.open', uri);
}

function reportMacCrashes(): void {
    if (process.platform === "darwin") {
        prevCrashFile = "";
        let crashFolder: string = path.resolve(process.env.HOME, "Library/Logs/DiagnosticReports");
        fs.stat(crashFolder, (err, stats) => {
            let crashObject: { [key: string]: string } = {};
            if (err) {
                // If the directory isn't there, we have a problem...
                crashObject["fs.stat: err.code"] = err.code;
                telemetry.logLanguageServerEvent("MacCrash", crashObject, null);
                return;
            }

            // vscode.workspace.createFileSystemWatcher only works in workspace folders.
            try {
                fs.watch(crashFolder, (event, filename) => {
                    if (event !== "rename") {
                        return;
                    }
                    if (filename === prevCrashFile) {
                        return;
                    }
                    prevCrashFile = filename;
                    if (!filename.startsWith("Microsoft.VSCode.CPP.")) {
                        return;
                    }
                    // Wait 5 seconds to allow time for the crash log to finish being written.
                    setTimeout(() => {
                        fs.readFile(path.resolve(crashFolder, filename), 'utf8', (err, data) => {
                            if (err) {
                                // Try again?
                                fs.readFile(path.resolve(crashFolder, filename), 'utf8', handleCrashFileRead);
                                return;
                            }
                            handleCrashFileRead(err, data);
                        });
                    }, 5000);
                });
            } catch (e) {
                // The file watcher limit is hit (may not be possible on Mac, but just in case).
            }
        });
    }
}

function handleCrashFileRead(err: NodeJS.ErrnoException, data: string): void {
    let crashObject: { [key: string]: string } = {};
    if (err) {
        crashObject["readFile: err.code"] = err.code;
        telemetry.logLanguageServerEvent("MacCrash", crashObject, null);
        return;
    }
    let startCrash: number = data.indexOf(" Crashed:");
    if (startCrash < 0) {
        startCrash = 0;
    }
    let endCrash: number = data.indexOf("Thread ", startCrash);
    if (endCrash < startCrash) {
        endCrash = data.length - 1;
    }
    data = data.substr(startCrash, endCrash - startCrash);
    if (data.length > 16384) {
        data = data.substr(0, 16384) + "...";
    }
    crashObject["CrashingThreadCallStack"] = data;
    telemetry.logLanguageServerEvent("MacCrash", crashObject, null);
}

export function deactivate(): Thenable<void> {
    console.log("deactivating extension");
    telemetry.logLanguageServerEvent("LanguageServerShutdown");
    clearInterval(intervalTimer);
    clearInterval(insiderUpdateTimer);
    disposables.forEach(d => d.dispose());
    languageConfigurations.forEach(d => d.dispose());
    ui.dispose();
    return clients.dispose();
}

export function isFolderOpen(): boolean {
    return vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
}

export function getClients(): ClientCollection {
    if (!realActivationOccurred) {
        realActivation();
    }
    return clients;
}

export function getActiveClient(): Client {
    if (!realActivationOccurred) {
        realActivation();
    }
    return clients.ActiveClient;
}