'use strict';
const vscode_languageserver_1 = require('vscode-languageserver');
const Log_1 = require('./Log');
const Settings_1 = require('./Settings');
const ViperProtocol_1 = require('./ViperProtocol');
const NailgunService_1 = require('./NailgunService');
const VerificationTask_1 = require('./VerificationTask');
const DebugServer_1 = require('./DebugServer');
var ipc = require('node-ipc');
class Server {
    static isViperSourceFile(uri) {
        return uri.endsWith(".sil") || uri.endsWith(".vpr");
    }
    static showHeap(task, index) {
        Server.connection.sendRequest(ViperProtocol_1.Commands.HeapGraph, task.getHeapGraphDescription(index));
    }
}
Server.documents = new vscode_languageserver_1.TextDocuments();
Server.verificationTasks = new Map();
exports.Server = Server;
// Create a connection for the server. The connection uses Node's IPC as a transport
Server.connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
Server.documents.listen(Server.connection);
registerHandlers();
function registerHandlers() {
    //starting point (executed once)
    Server.connection.onInitialize((params) => {
        DebugServer_1.DebugServer.initialize();
        Server.workspaceRoot = params.rootPath;
        Server.nailgunService = new NailgunService_1.NailgunService();
        return {
            capabilities: {
                // Tell the client that the server works in FULL text document sync mode
                textDocumentSync: Server.documents.syncKind,
                // Tell the client that the server support code complete
                completionProvider: {
                    resolveProvider: true
                }
            }
        };
    });
    Server.connection.onExit(() => {
        Log_1.Log.log("On Exit", ViperProtocol_1.LogLevel.Debug);
    });
    Server.connection.onShutdown(() => {
        Log_1.Log.log("On Shutdown", ViperProtocol_1.LogLevel.Debug);
        Server.nailgunService.stopNailgunServer();
    });
    Server.connection.onDidChangeConfiguration((change) => {
        try {
            Settings_1.Settings.settings = change.settings.viperSettings;
            //after this line, Logging works
            Log_1.Log.logLevel = Settings_1.Settings.settings.logLevel;
            Log_1.Log.log('configuration changed', ViperProtocol_1.LogLevel.Info);
            //check settings
            let error = Settings_1.Settings.checkSettings(Settings_1.Settings.settings);
            if (error) {
                Server.connection.sendNotification(ViperProtocol_1.Commands.InvalidSettings, error);
                return;
            }
            else {
                Log_1.Log.log("The settings are ok", ViperProtocol_1.LogLevel.Info);
            }
            //pass the new settings to the verificationService and the Log
            Server.nailgunService.changeSettings(Settings_1.Settings.settings);
            //stop all running verifications
            Log_1.Log.log("Stop all running verificationTasks", ViperProtocol_1.LogLevel.Debug);
            Server.verificationTasks.forEach(task => { task.abortVerification(); });
            Server.backend = Settings_1.Settings.autoselectBackend(Settings_1.Settings.settings);
            Server.nailgunService.restartNailgunServer(Server.connection, Server.backend);
        }
        catch (e) {
            Log_1.Log.error("Error handling configuration change: " + e);
        }
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.SelectBackend, (selectedBackend) => {
        if (!Settings_1.Settings.settings.valid) {
            Server.connection.sendNotification(ViperProtocol_1.Commands.InvalidSettings, "Cannot start backend, fix settings first.");
            return;
        }
        if (selectedBackend) {
            Settings_1.Settings.selectedBackend = selectedBackend;
        }
        Log_1.Log.log("Stop all running verificationTasks", ViperProtocol_1.LogLevel.Debug);
        Server.verificationTasks.forEach(task => { task.abortVerification(); });
        Server.backend = Settings_1.Settings.autoselectBackend(Settings_1.Settings.settings);
        Server.nailgunService.restartNailgunServer(Server.connection, Server.backend);
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.RequestBackendSelection, (args) => {
        let backendNames = Settings_1.Settings.getBackendNames(Settings_1.Settings.settings);
        if (backendNames.length > 1) {
            Server.connection.sendRequest(ViperProtocol_1.Commands.AskUserToSelectBackend, backendNames);
        }
        else {
            Log_1.Log.hint("There are less than two backends, selecting does not make sense.");
        }
    });
    Server.connection.onDidChangeWatchedFiles((change) => {
        Log_1.Log.log("We recevied a file change event", ViperProtocol_1.LogLevel.Debug);
    });
    Server.connection.onDidOpenTextDocument((params) => {
        if (Server.isViperSourceFile(params.textDocument.uri)) {
            let uri = params.textDocument.uri;
            if (!Server.verificationTasks.has(uri)) {
                //create new task for opened file
                let task = new VerificationTask_1.VerificationTask(uri, Server.nailgunService, Server.connection);
                Server.verificationTasks.set(uri, task);
                Log_1.Log.log(`${uri} opened, task created`, ViperProtocol_1.LogLevel.Debug);
                if (Server.nailgunService.ready) {
                    Log_1.Log.log("Opened Text Document", ViperProtocol_1.LogLevel.Debug);
                    startOrRestartVerification(uri, false, false);
                }
            }
        }
    });
    Server.connection.onDidCloseTextDocument((params) => {
        if (Server.isViperSourceFile(params.textDocument.uri)) {
            let uri = params.textDocument.uri;
            if (Server.verificationTasks.has(uri)) {
                //remove no longer needed task
                Server.verificationTasks.delete(uri);
                Log_1.Log.log(`${params.textDocument.uri} closed, task deleted`, ViperProtocol_1.LogLevel.Debug);
            }
        }
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.Verify, (data) => {
        if (Server.isViperSourceFile(data.uri)) {
            let alreadyRunning = false;
            if (data.manuallyTriggered) {
                //it does not make sense to reverify if no changes were made and the verification is already running
                Server.verificationTasks.forEach(task => {
                    if (task.running && task.fileUri === data.uri) {
                        alreadyRunning = true;
                    }
                });
            }
            if (!alreadyRunning) {
                Settings_1.Settings.workspace = data.workspace;
                startOrRestartVerification(data.uri, false, data.manuallyTriggered);
            }
        }
        else if (data.manuallyTriggered) {
            Log_1.Log.hint("This system can only verify .sil and .vpr files");
        }
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.Dispose, (lineNumber) => {
        Server.nailgunService.stopNailgunServer();
        Server.nailgunService.killNgDeamon();
        return null;
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.StopVerification, (uri) => {
        let task = Server.verificationTasks.get(uri);
        task.abortVerification();
        Server.connection.sendNotification(ViperProtocol_1.Commands.StateChange, { newState: ViperProtocol_1.VerificationState.Ready, firstTime: true, verificationNeeded: false });
    });
    Server.connection.onRequest(ViperProtocol_1.Commands.ShowHeap, (params) => {
        try {
            let task = Server.verificationTasks.get(params.uri);
            if (!task) {
                Log_1.Log.error("No verificationTask found for " + params.uri);
                return;
            }
            Server.showHeap(task, params.index);
        }
        catch (e) {
            Log_1.Log.error("Error showing heap: " + e);
        }
    });
    // Server.documents.onDidChangeContent((change) => {Log.error("TODO: never happened before: Content Change detected")});
    // Server.connection.onDidChangeTextDocument((params) => {});
    // Server.connection.onDidSaveTextDocument((params) => {})
    // Listen on the connection
    Server.connection.listen();
}
function resetDiagnostics(uri) {
    let task = Server.verificationTasks.get(uri);
    if (!task) {
        Log_1.Log.error("no verification Task for file: " + uri);
        return;
    }
    task.resetDiagnostics();
}
function startOrRestartVerification(uri, onlyTypeCheck, manuallyTriggered) {
    Log_1.Log.log("start or restart verification of " + uri, ViperProtocol_1.LogLevel.Info);
    //only verify if the settings are right
    if (!Settings_1.Settings.settings.valid) {
        Server.connection.sendNotification(ViperProtocol_1.Commands.InvalidSettings, "Cannot verify, fix the settings first.");
        return;
    }
    //only verify viper source code files
    if (!Server.isViperSourceFile(uri)) {
        Log_1.Log.hint("Only viper source files can be verified.");
        return;
    }
    //only verify if the settings are right
    if (!Server.backend) {
        Log_1.Log.log("no backend has beed selected, the first was picked by default.", ViperProtocol_1.LogLevel.Debug);
        Server.backend = Settings_1.Settings.settings.verificationBackends[0];
        Server.nailgunService.startNailgunIfNotRunning(Server.connection, Server.backend);
    }
    if (!Server.nailgunService.ready) {
        Log_1.Log.hint("The verification backend is not ready yet");
        return;
    }
    //check if there is already a verification task for that file
    let task = Server.verificationTasks.get(uri);
    if (!task) {
        Log_1.Log.error("No verification task found for file: " + uri);
        return;
    }
    //stop all other verifications because the backend crashes if multiple verifications are run in parallel
    Server.verificationTasks.forEach(task => { task.abortVerification(); });
    //start verification
    task.verify(onlyTypeCheck, manuallyTriggered);
}
/*
// This handler provides the initial list of the completion items.
Server.connection.onCompletion((textPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    var res = [];
    let completionItem: CompletionItem = {
        label: 'invariant',
        kind: CompletionItemKind.Text,
        data: 1
    };
    res.push(completionItem);
    return res;
});
// This handler resolve additional information for the item selected in
// the completion list.
Server.connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    //Log.log('onCompletionResolve');
    if (item.data === 1) {
        item.detail = 'add an invariant',
            item.documentation = 'The invariant needs to hold before and after the loop body'
    }
    return item;
});
*/
/*
function readZ3LogFile(path: string): LogEntry[] {
    let res: LogEntry[] = new Array<LogEntry>();
    if (!fs.existsSync(path)) {
        Log.error("cannot find log file at: " + path);
        return;
    }
    let content = fs.readFileSync(path, "utf8").split(/\n(?!\s)/g);

    for (var i = 0; i < content.length; i++) {
        var line = content[i].replace("\n", "").trim();

        if (line == '') {
            continue;
        }
        let prefix = ';';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.Comment, line.substring(prefix.length)));
            continue;
        }
        prefix = '(push)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.Push, line.substring(prefix.length)));
            continue;
        }
        prefix = '(pop)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.Pop, line.substring(prefix.length)));
            continue;
        }
        prefix = '(set-option';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.SetOption, line));
            continue;
        }
        prefix = '(declare-const';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DeclareConst, line));
            continue;
        }
        prefix = '(declare-fun';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DeclareFun, line));
            continue;
        }
        prefix = '(declare-datatypes';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DeclareDatatypes, line));
            continue;
        }
        prefix = '(declare-sort';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DeclareSort, line));
            continue;
        }
        prefix = '(define-const';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DefineConst, line));
            continue;
        }
        prefix = '(define-fun';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DefineFun, line));
            continue;
        }
        prefix = '(define-datatypes';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DefineDatatypes, line));
            continue;
        }
        prefix = '(define-sort';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.DefineSort, line));
            continue;
        }
        prefix = '(assert';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.Assert, line));
            continue;
        }
        prefix = '(check-sat)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.CheckSat, line.substring(prefix.length)));
            continue;
        }
        prefix = '(get-info';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry(LogType.GetInfo, line));
            continue;
        }
        Log.error("unknown log-entry-type detected: " + line);
    }
    return res;
}
*/ 
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc2VydmVyL3NyYy9zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsWUFBWSxDQUFDO0FBTWIsd0NBT08sdUJBQXVCLENBQUMsQ0FBQTtBQUcvQixzQkFBa0IsT0FBTyxDQUFDLENBQUE7QUFDMUIsMkJBQXVCLFlBQ3ZCLENBQUMsQ0FEa0M7QUFDbkMsZ0NBQXFILGlCQUNySCxDQUFDLENBRHFJO0FBQ3RJLGlDQUE2QixrQkFBa0IsQ0FBQyxDQUFBO0FBQ2hELG1DQUErQixvQkFBb0IsQ0FBQyxDQUFBO0FBR3BELDhCQUEwQixlQUFlLENBQUMsQ0FBQTtBQUMxQyxJQUFJLEdBQUcsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLENBQUM7QUFFOUI7SUFVSSxPQUFPLGlCQUFpQixDQUFDLEdBQVc7UUFDaEMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4RCxDQUFDO0lBRUQsT0FBTyxRQUFRLENBQUMsSUFBc0IsRUFBRSxLQUFhO1FBQ2pELE1BQU0sQ0FBQyxVQUFVLENBQUMsV0FBVyxDQUFDLHdCQUFRLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzNGLENBQUM7QUFDTCxDQUFDO0FBYlUsZ0JBQVMsR0FBa0IsSUFBSSxxQ0FBYSxFQUFFLENBQUM7QUFDL0Msd0JBQWlCLEdBQWtDLElBQUksR0FBRyxFQUFFLENBQUM7QUFMM0QsY0FBTSxTQWlCbEIsQ0FBQTtBQUVELG9GQUFvRjtBQUNwRixNQUFNLENBQUMsVUFBVSxHQUFHLHdDQUFnQixDQUFDLElBQUksd0NBQWdCLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSx3Q0FBZ0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQ25HLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUUzQyxnQkFBZ0IsRUFBRSxDQUFDO0FBRW5CO0lBQ0ksZ0NBQWdDO0lBQ2hDLE1BQU0sQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUMsTUFBTTtRQUNsQyx5QkFBVyxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBRXpCLE1BQU0sQ0FBQyxhQUFhLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQztRQUN2QyxNQUFNLENBQUMsY0FBYyxHQUFHLElBQUksK0JBQWMsRUFBRSxDQUFDO1FBQzdDLE1BQU0sQ0FBQztZQUNILFlBQVksRUFBRTtnQkFDVix3RUFBd0U7Z0JBQ3hFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxTQUFTLENBQUMsUUFBUTtnQkFDM0Msd0RBQXdEO2dCQUN4RCxrQkFBa0IsRUFBRTtvQkFDaEIsZUFBZSxFQUFFLElBQUk7aUJBQ3hCO2FBQ0o7U0FDSixDQUFBO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQztRQUNyQixTQUFHLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSx3QkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3ZDLENBQUMsQ0FBQyxDQUFBO0lBRUYsTUFBTSxDQUFDLFVBQVUsQ0FBQyxVQUFVLENBQUM7UUFDekIsU0FBRyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsd0JBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxNQUFNLENBQUMsY0FBYyxDQUFDLGlCQUFpQixFQUFFLENBQUM7SUFDOUMsQ0FBQyxDQUFDLENBQUE7SUFFRixNQUFNLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLENBQUMsTUFBTTtRQUM5QyxJQUFJLENBQUM7WUFDRCxtQkFBUSxDQUFDLFFBQVEsR0FBa0IsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUM7WUFDakUsZ0NBQWdDO1lBQ2hDLFNBQUcsQ0FBQyxRQUFRLEdBQUcsbUJBQVEsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDO1lBRTFDLFNBQUcsQ0FBQyxHQUFHLENBQUMsdUJBQXVCLEVBQUUsd0JBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNoRCxnQkFBZ0I7WUFDaEIsSUFBSSxLQUFLLEdBQUcsbUJBQVEsQ0FBQyxhQUFhLENBQUMsbUJBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN0RCxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO2dCQUNSLE1BQU0sQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLENBQUMsd0JBQVEsQ0FBQyxlQUFlLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQ3BFLE1BQU0sQ0FBQztZQUNYLENBQUM7WUFBQyxJQUFJLENBQUMsQ0FBQztnQkFDSixTQUFHLENBQUMsR0FBRyxDQUFDLHFCQUFxQixFQUFFLHdCQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDbEQsQ0FBQztZQUVELDhEQUE4RDtZQUM5RCxNQUFNLENBQUMsY0FBYyxDQUFDLGNBQWMsQ0FBQyxtQkFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBRXhELGdDQUFnQztZQUNoQyxTQUFHLENBQUMsR0FBRyxDQUFDLG9DQUFvQyxFQUFFLHdCQUFRLENBQUMsS0FBSyxDQUFDLENBQUE7WUFDN0QsTUFBTSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxJQUFJLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUV4RSxNQUFNLENBQUMsT0FBTyxHQUFHLG1CQUFRLENBQUMsaUJBQWlCLENBQUMsbUJBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUMvRCxNQUFNLENBQUMsY0FBYyxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQyxVQUFVLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2xGLENBQUU7UUFBQSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ1QsU0FBRyxDQUFDLEtBQUssQ0FBQyx1Q0FBdUMsR0FBQyxDQUFDLENBQUMsQ0FBQztRQUN6RCxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyx3QkFBUSxDQUFDLGFBQWEsRUFBRSxDQUFDLGVBQXVCO1FBQ3hFLEVBQUUsQ0FBQyxDQUFDLENBQUMsbUJBQVEsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUMzQixNQUFNLENBQUMsVUFBVSxDQUFDLGdCQUFnQixDQUFDLHdCQUFRLENBQUMsZUFBZSxFQUFFLDJDQUEyQyxDQUFDLENBQUM7WUFDMUcsTUFBTSxDQUFDO1FBQ1gsQ0FBQztRQUNELEVBQUUsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUM7WUFDbEIsbUJBQVEsQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDO1FBQy9DLENBQUM7UUFDRCxTQUFHLENBQUMsR0FBRyxDQUFDLG9DQUFvQyxFQUFFLHdCQUFRLENBQUMsS0FBSyxDQUFDLENBQUE7UUFDN0QsTUFBTSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxJQUFJLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN4RSxNQUFNLENBQUMsT0FBTyxHQUFHLG1CQUFRLENBQUMsaUJBQWlCLENBQUMsbUJBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUMvRCxNQUFNLENBQUMsY0FBYyxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQyxVQUFVLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2xGLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBTSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsd0JBQVEsQ0FBQyx1QkFBdUIsRUFBRSxDQUFDLElBQUk7UUFDL0QsSUFBSSxZQUFZLEdBQWEsbUJBQVEsQ0FBQyxlQUFlLENBQUMsbUJBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN6RSxFQUFFLENBQUMsQ0FBQyxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDMUIsTUFBTSxDQUFDLFVBQVUsQ0FBQyxXQUFXLENBQUMsd0JBQVEsQ0FBQyxzQkFBc0IsRUFBRSxZQUFZLENBQUMsQ0FBQztRQUNqRixDQUFDO1FBQUMsSUFBSSxDQUFDLENBQUM7WUFDSixTQUFHLENBQUMsSUFBSSxDQUFDLGtFQUFrRSxDQUFDLENBQUM7UUFDakYsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBTSxDQUFDLFVBQVUsQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDLE1BQU07UUFDN0MsU0FBRyxDQUFDLEdBQUcsQ0FBQyxpQ0FBaUMsRUFBRSx3QkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQzlELENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBTSxDQUFDLFVBQVUsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDLE1BQU07UUFDM0MsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLGlCQUFpQixDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3BELElBQUksR0FBRyxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDO1lBQ2xDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3JDLGlDQUFpQztnQkFDakMsSUFBSSxJQUFJLEdBQUcsSUFBSSxtQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLGNBQWMsRUFBRSxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQy9FLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDO2dCQUN4QyxTQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyx1QkFBdUIsRUFBRSx3QkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUN2RCxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7b0JBQzlCLFNBQUcsQ0FBQyxHQUFHLENBQUMsc0JBQXNCLEVBQUUsd0JBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztvQkFDaEQsMEJBQTBCLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDbEQsQ0FBQztZQUNMLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLHNCQUFzQixDQUFDLENBQUMsTUFBTTtRQUM1QyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDcEQsSUFBSSxHQUFHLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUM7WUFDbEMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3BDLDhCQUE4QjtnQkFDOUIsTUFBTSxDQUFDLGlCQUFpQixDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDckMsU0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsR0FBRyx1QkFBdUIsRUFBRSx3QkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQy9FLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyx3QkFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQW1CO1FBQzdELEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3JDLElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQztZQUMzQixFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDO2dCQUN6QixvR0FBb0c7Z0JBQ3BHLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsSUFBSTtvQkFDakMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsT0FBTyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO3dCQUM1QyxjQUFjLEdBQUcsSUFBSSxDQUFDO29CQUMxQixDQUFDO2dCQUNMLENBQUMsQ0FBQyxDQUFDO1lBQ1AsQ0FBQztZQUNELEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztnQkFDbEIsbUJBQVEsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEMsMEJBQTBCLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7WUFDeEUsQ0FBQztRQUNMLENBQUM7UUFBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQztZQUNoQyxTQUFHLENBQUMsSUFBSSxDQUFDLGlEQUFpRCxDQUFDLENBQUM7UUFDaEUsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsTUFBTSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsd0JBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxVQUFVO1FBQ3JELE1BQU0sQ0FBQyxjQUFjLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUMxQyxNQUFNLENBQUMsY0FBYyxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxJQUFJLENBQUM7SUFDaEIsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyx3QkFBUSxDQUFDLGdCQUFnQixFQUFFLENBQUMsR0FBVztRQUMvRCxJQUFJLElBQUksR0FBRyxNQUFNLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzdDLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1FBQ3pCLE1BQU0sQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLENBQUMsd0JBQVEsQ0FBQyxXQUFXLEVBQUUsRUFBRSxRQUFRLEVBQUUsaUNBQWlCLENBQUMsS0FBSyxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsa0JBQWtCLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUNoSixDQUFDLENBQUMsQ0FBQztJQUVILE1BQU0sQ0FBQyxVQUFVLENBQUMsU0FBUyxDQUFDLHdCQUFRLENBQUMsUUFBUSxFQUFFLENBQUMsTUFBc0I7UUFDbEUsSUFBRyxDQUFDO1lBQ0osSUFBSSxJQUFJLEdBQUcsTUFBTSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDcEQsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO2dCQUNSLFNBQUcsQ0FBQyxLQUFLLENBQUMsZ0NBQWdDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUN6RCxNQUFNLENBQUM7WUFDWCxDQUFDO1lBQ0QsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXBDLENBQUM7UUFBQSxLQUFLLENBQUEsQ0FBQyxDQUFDLENBQUMsQ0FBQSxDQUFDO1lBQ04sU0FBRyxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsR0FBRSxDQUFDLENBQUMsQ0FBQztRQUN6QyxDQUFDO0lBQ1QsQ0FBQyxDQUFDLENBQUM7SUFFQyx3SEFBd0g7SUFDeEgsNkRBQTZEO0lBQzdELDBEQUEwRDtJQUUxRCwyQkFBMkI7SUFDM0IsTUFBTSxDQUFDLFVBQVUsQ0FBQyxNQUFNLEVBQUUsQ0FBQztBQUMvQixDQUFDO0FBRUQsMEJBQTBCLEdBQVc7SUFDakMsSUFBSSxJQUFJLEdBQUcsTUFBTSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM3QyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDUixTQUFHLENBQUMsS0FBSyxDQUFDLGlDQUFpQyxHQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQ25ELE1BQU0sQ0FBQztJQUNYLENBQUM7SUFDRCxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztBQUM1QixDQUFDO0FBRUQsb0NBQW9DLEdBQVcsRUFBRSxhQUFzQixFQUFFLGlCQUEwQjtJQUMvRixTQUFHLENBQUMsR0FBRyxDQUFDLG1DQUFtQyxHQUFHLEdBQUcsRUFBRSx3QkFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xFLHVDQUF1QztJQUN2QyxFQUFFLENBQUMsQ0FBQyxDQUFDLG1CQUFRLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDM0IsTUFBTSxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0IsQ0FBQyx3QkFBUSxDQUFDLGVBQWUsRUFBRSx3Q0FBd0MsQ0FBQyxDQUFDO1FBQ3ZHLE1BQU0sQ0FBQztJQUNYLENBQUM7SUFFRCxxQ0FBcUM7SUFDckMsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pDLFNBQUcsQ0FBQyxJQUFJLENBQUMsMENBQTBDLENBQUMsQ0FBQztRQUNyRCxNQUFNLENBQUM7SUFDWCxDQUFDO0lBRUQsdUNBQXVDO0lBQ3ZDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDbEIsU0FBRyxDQUFDLEdBQUcsQ0FBQyxnRUFBZ0UsRUFBRSx3QkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFGLE1BQU0sQ0FBQyxPQUFPLEdBQUcsbUJBQVEsQ0FBQyxRQUFRLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDM0QsTUFBTSxDQUFDLGNBQWMsQ0FBQyx3QkFBd0IsQ0FBQyxNQUFNLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN0RixDQUFDO0lBQ0QsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDL0IsU0FBRyxDQUFDLElBQUksQ0FBQywyQ0FBMkMsQ0FBQyxDQUFDO1FBQ3RELE1BQU0sQ0FBQztJQUNYLENBQUM7SUFFRCw2REFBNkQ7SUFDN0QsSUFBSSxJQUFJLEdBQUcsTUFBTSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM3QyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDUixTQUFHLENBQUMsS0FBSyxDQUFDLHVDQUF1QyxHQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQ3pELE1BQU0sQ0FBQztJQUNYLENBQUM7SUFDRCx3R0FBd0c7SUFDeEcsTUFBTSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxJQUFJLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN4RSxvQkFBb0I7SUFDcEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxhQUFhLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztBQUNsRCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7RUF5QkU7QUFDRjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztFQThGRSJ9