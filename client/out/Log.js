'use strict';
const vscode = require("vscode");
const path = require('path');
const fs = require('fs');
const ViperProtocol_1 = require('./ViperProtocol');
const Helper_1 = require('./Helper');
class Log {
    static initialize(context) {
        Log.updateSettings();
        Log.rootPath = vscode.workspace.rootPath;
        if (!Log.rootPath) {
            Log.rootPath = path.dirname(vscode.window.activeTextEditor.document.fileName);
        }
        Log.logFilePath = path.join(Log.rootPath, '.vscode', Log.logFilePath);
        //create .vscode folder if not there yet
        if (!fs.existsSync(path.join(Log.rootPath, '.vscode'))) {
            fs.mkdirSync(path.join(Log.rootPath, '.vscode'));
        }
        Log._dotBasePath = path.join(Log.rootPath, '.vscode', 'heap');
        Log._svgBasePath = path.join(Log.rootPath, '.vscode', 'heap');
        Log.symbExLogFilePath = path.join(Log.rootPath, '.vscode', 'executionTreeData.js');
        Log.log('LogFilePath is: "' + Log.logFilePath + '"', ViperProtocol_1.LogLevel.LowLevelDebug);
        try {
            Log.createFile(Log.logFilePath);
            Log.logFile = fs.createWriteStream(Log.logFilePath);
            //make sure the logFile is closed when the extension is closed
            context.subscriptions.push(new Log());
        }
        catch (e) {
            Log.error("cannot write to LogFile, access denied. " + e);
        }
    }
    ///return the path to the indexth dot file
    ///creates non existing files
    static dotFilePath(index, oldHeap) {
        let old = oldHeap ? "_old" : "";
        if (index < 0) {
            Log.error("don't use negative indices for dotFilePath");
            return this._dotBasePath + old + ".dot";
        }
        if (index >= this.MAX_DOT_FILES) {
            Log.error("don't use more than " + this.MAX_DOT_FILES + " dotFiles");
            return this._dotBasePath + old + ".dot";
        }
        return this._dotBasePath + index + old + ".dot";
    }
    static svgFilePath(index, oldHeap) {
        let old = oldHeap ? "_old" : "";
        if (index < 0) {
            Log.error("don't use negative indices for svgFilePath");
            return this._svgBasePath + old + ".svg";
        }
        if (index >= this.MAX_DOT_FILES) {
            Log.error("don't use more than " + this.MAX_DOT_FILES + " svgFiles");
            return this._svgBasePath + old + ".svg";
        }
        return this._svgBasePath + index + old + ".svg";
    }
    static createFile(filePath) {
        if (!fs.existsSync(filePath)) {
            fs.closeSync(fs.openSync(filePath, 'w'));
            fs.accessSync(filePath);
        }
    }
    static writeToDotFile(graphDescription, oldHeap, index) {
        //delete and recreate file to fix the problem of not being able to open the dot files      
        let dotFilePath = this.dotFilePath(index, oldHeap);
        this.createFile(dotFilePath);
        let dotFile = fs.createWriteStream(dotFilePath);
        dotFile.write(graphDescription);
        dotFile.close();
    }
    static deleteDotFiles() {
        //delete all dotFiles
        for (let i = 0; i < this.MAX_DOT_FILES; i++) {
            this.deleteFile(this.dotFilePath(i, true));
            this.deleteFile(this.dotFilePath(i, false));
        }
        this._nofFiles = 0;
    }
    static deleteFile(fileName) {
        try {
            if (fs.existsSync(fileName)) {
                fs.unlinkSync(fileName);
            }
            ;
        }
        catch (e) {
            Log.error("Error deleting file " + fileName);
        }
    }
    static updateSettings() {
        let oldLogLevel = Log.logLevel;
        let settings = vscode.workspace.getConfiguration("viperSettings");
        Log.logLevel = Helper_1.Helper.getConfiguration("preferences").logLevel || ViperProtocol_1.LogLevel.Default;
        if (oldLogLevel && oldLogLevel != Log.logLevel)
            Log.log(`The logLevel was changed from ${ViperProtocol_1.LogLevel[oldLogLevel]} to ${ViperProtocol_1.LogLevel[Log.logLevel]}`, ViperProtocol_1.LogLevel.LowLevelDebug);
    }
    static log(message, logLevel = ViperProtocol_1.LogLevel.Default) {
        let messageNewLine = message + "\n";
        message = this.prefix(logLevel) + message;
        if (Log.logLevel >= logLevel) {
            console.log(message);
            Log.outputChannel.append(messageNewLine);
        }
        if (Log.logFile) {
            Log.logFile.write(messageNewLine);
        }
    }
    static prefix(logLevel) {
        if (logLevel <= ViperProtocol_1.LogLevel.Info)
            return "";
        if (logLevel == ViperProtocol_1.LogLevel.Debug)
            return "> ";
        if (logLevel == ViperProtocol_1.LogLevel.Verbose)
            return "- ";
        if (logLevel == ViperProtocol_1.LogLevel.LowLevelDebug) {
            return ". ";
        }
    }
    static toLogFile(message, logLevel = ViperProtocol_1.LogLevel.Default) {
        if (Log.logLevel >= logLevel && Log.logFile) {
            let messageNewLine = message + "\n";
            Log.logFile.write(messageNewLine);
        }
    }
    static error(message, logLevel = ViperProtocol_1.LogLevel.Debug) {
        let messageNewLine = "ERROR: " + message + "\n";
        if (Log.logLevel >= logLevel && Log.logFile) {
            console.error(message);
            Log.outputChannel.append(messageNewLine);
        }
        if (Log.logFile) {
            Log.logFile.write(messageNewLine);
        }
    }
    dispose() {
        Log.logFile.close();
    }
    static hint(message) {
        Log.log("H: " + message, ViperProtocol_1.LogLevel.Debug);
        vscode.window.showInformationMessage("Viper: " + message);
    }
}
Log.logFilePath = "viper.log";
Log.outputChannel = vscode.window.createOutputChannel('Viper');
Log._nofFiles = 0;
Log.MAX_DOT_FILES = 2;
exports.Log = Log;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL0xvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxZQUFZLENBQUM7QUFFYixNQUFZLE1BQU0sV0FBTSxRQUFRLENBQUMsQ0FBQTtBQUNqQyxNQUFZLElBQUksV0FBTSxNQUFNLENBQUMsQ0FBQTtBQUM3QixNQUFZLEVBQUUsV0FBTSxJQUFJLENBQUMsQ0FBQTtBQUN6QixnQ0FBdUIsaUJBQWlCLENBQUMsQ0FBQTtBQUN6Qyx5QkFBcUIsVUFBVSxDQUFDLENBQUE7QUFFaEM7SUFhSSxPQUFjLFVBQVUsQ0FBQyxPQUFnQztRQUNyRCxHQUFHLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDckIsR0FBRyxDQUFDLFFBQVEsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQztRQUN6QyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO1lBQ2hCLEdBQUcsQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNsRixDQUFDO1FBQ0QsR0FBRyxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsU0FBUyxFQUFFLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUN0RSx3Q0FBd0M7UUFDeEMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNyRCxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO1FBQ3JELENBQUM7UUFFRCxHQUFH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