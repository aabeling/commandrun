"use strict";

/*
 *  Workhorse for CommandRun
 *
 *  Talks to the Native App, and the content page using messages.
 */
var RESTART_TIME = 60 * 1000; /* 1 minute */
var runner;
var control;


/**
 *  Starts the Native App
 *
 *  Start the native app, and start a watchdog to restart the Native App
 *  if it crashes.  It delays restarts to prevent running wild.
 */
function startRunner() {
    console.log("starting native app");
    runner = browser.runtime.connectNative("commandrun");
    console.debug("opened commandrun runner");

    runner.onDisconnect.addListener(
        /**
         *  Restart the Native App if it disconnects.
         *
         *  @param {Port} p - Error code.  We ignore it, and restart regardless.
         */
        (p) => {
            console.warn("disconnected");
            setTimeout(startRunner, RESTART_TIME);
    });

    runner.onMessage.addListener(
        /**
         *  Listen for messages from the app
         *
         *  Listen for messges from the app.  This just sends them pack to
         *  the controller.
         *
         *  @param {Object} response - Native Message response.
         */
        (response) => {
            console.debug("Received: " + response);
            control.sendResponse(response);
            console.debug("processed: " + response);
    });
}


/**
 *  Keeps track of the commands being run.
 *
 *  We run commands asynchronously, and receive responses back, so we
 *  need to keep track of multiple commands for some seconds.
 *
 *  @constructor
 */
var Controller = function() {
    /** @type {Array.<function({errno: number,
     *                          stdout: string,
     *                          stderr: string})>} */
    this.responders = [];
    /** @type {Array.<Array.<string>>} */
    this.commands = [];
    /** @type {Array.<string>} */
    this.urls = [];
    return this;
}


/**
 *  Generate a PID
 *
 *  @todo this works for (number of commands) << (max size of array)
 *
 *  @function
 *  @returns {number}
 */
Controller.prototype.newPid = function() {
    console.debug("Controller.newPid()");
    console.warn("we should not always return 0");
    return this.responders.length;
}


/**
 *  Save the responder function
 *
 *  When the asynchronous command returns, we need to respond to the
 *  Promise.  To do that, we first save the responder.
 *
 *  @function
 *  @param {number} pid - identifier of command (not an OS pid)
 *  @param {function({errno: number,
 *                    stdout: string,
 *                    stderr: string})} responder
 */
Controller.prototype.setResponder = function(pid, responder) {
    console.debug("Controller.setResponder()");
    this.responders[pid] = responder;
    console.debug("Controller.setResponder(): done");
}


/**
 *  Save the command
 *
 *  When the command is submitted, we need to check it to the list of
 *  allowed commands before running it.  That list comes from browser
 *  storage, which is asynchronous.  We save it, so we can compare it
 *  when the browser storage completes, so we can check it before running
 *  it.
 *
 *  @function
 *  @param {number} pid            - identifier of command (not an OS pid)
 *  @param {Array<string>} command - command to run
 */
Controller.prototype.setCommand = function(pid, command) {
    console.debug("Controller.setCommand()");
    this.commands[pid] = command;
    console.debug("Controller.setCommand(): done");
}


/**
 *  Save the URL
 *
 *  When the command is submitted, we need to check it to the list of
 *  permitted sites before running it.  That list comes from browser
 *  storage, which is asynchronous.  We save it, so we can compare it
 *  when the browser storage completes, so we can check it before running
 *  it.
 *
 *  @function
 *  @param {number} pid - identifier of command (not an OS pid)
 *  @param {string} url - site that wants to run the command
 */
Controller.prototype.setURL = function(pid, url) {
    console.debug("Controller.setURL()");
    this.urls[pid] = url;
    console.debug("Controller.setURL(): done");
}


/**
 *  Complete the promise
 *
 *  When the command has completed, we need to send the output back
 *  to the content page.
 *
 *  We strip out the pid, and remove the base64 encoding.  Python uses
 *  UTF-8, and Javascript uses UTF-16.
 *
 *  @function
 *  @param {{handle: number,
 *           errno: number,
 *           stdout: string,
 *           stderr: string}} response
 */
Controller.prototype.sendResponse = function(response) {
    var pid = response.handle;
    var responder = this.responders[pid];
    console.debug("going to respond on ", responder);
    console.debug("responding with ", response);
    response.stdout = atob(response.stdout);
    response.stderr = atob(response.stderr);
    delete response.handle;
    console.debug("responding with ", response);
    responder(response);
    console.debug("responded");
}

Controller.prototype.prepare = function(pid) {
    //var msg = {action:"run", what:message, handle:pid};
    //runner.postMessage(msg);
    console.debug("Controller.prepare():", pid);
    function onError(error) {
        console.warn(`Error: ${error}`);
    }
    function permitted(url, list) {
        console.debug("permitted(): start");
        var u = new URL(url);
        var found = false;
        console.debug("permitted(): hostname=", u.hostname);
        list.forEach(function(element) {
            console.debug("permitted(): matching=", element);
            if (element[0] == "*") {
                element = element.substring(element.length - 1);
                console.debug("permitted(): matching chopped=", element);
            }
            if (u.hostname.length < element.length) {
                console.debug("permitted(): too short");
                return; 
            }
            if (u.hostname == element) {
                console.debug("permitted(): exact match");
                found = true;
                return;
            }
            if (element[0] == ".") {
                var end = u.hostname.substring(u.hostname.length - element.length);
                console.debug("permitted(): considering=", end);
                if (element == end) {
                    console.debug("permitted(): domain match");
                    found = true;
                    return;
                }
            }
        });
        return found;
    }
    function checkAndRun(that, pid) {
        console.debug("checkAndRun(): starting with pid=", pid);
        console.debug("checkAndRun(): this=", that);
        var message = that.commands[pid];
        console.debug("checkAndRun(): message=", message);
        var cmd = message[0];
        var responder = that.responders[pid];
        var url = that.urls[pid];
        console.debug("checkAndRun(): stopping");
        return function(result) {
            var allowed_commands;
            var permitted_sites;
            var command = cmd;
            if (result.allowed_commands) {
                console.debug("background/saved commands:", result.allowed_commands);
                allowed_commands = result.allowed_commands;
            } else {
                console.debug("background/no allowed commands set");
                allowed_commands = ["@ALLOWED_COMMANDS@"];
            }
            if (result.permitted_sites) {
                console.debug("background/permitted sites:", result.permitted_sites);
                permitted_sites = result.permitted_sites;
            } else {
                console.debug("background/no permitted set");
                permitted_sites = ["@PERMITTED_SITES@"];
            }
            if (allowed_commands.includes(cmd) &&
                permitted(url, permitted_sites)) {
                 console.debug("allowed command, forwarding");
                 var msg = {action:"run", what:message, handle:pid};
                 runner.postMessage(msg);
            } else {
                 console.debug("forbidden command");
                 var response = {handle: pid, errno: -1, stdout: "", stderr: "forbidden command"};
                 responder(response);
            }
        }
    }
    console.debug("Controller.prepare(): syncing storage");
    var processor = checkAndRun(this,pid);
    console.debug("Controller.prepare():", processor);
    var getting = browser.storage.sync.get(["allowed_commands", "permitted_sites"]);
    console.debug("Controller.prepare(): chainging promise");
    getting.then(processor, onError); 
}


/* UNUSED
function allowedCommand(cmd) {
    var allowed_commands;

    function getCommands(result) {
        if (result.allowed_commands) {
            console.debug("background/saved commands:", result.allowed_commands);
            allowed_commands = result.allowed_commands.join(" ");
        } else {
            console.debug("background/no allowed commands set");
            allowed_commands = "/usr/bin/ls";
        }
    }

    function onError(result) {
        console.warn("do nothing");
    }

    var getting = browser.storage.sync.get("allowed_commands");
    getting.then(getCommands, onError); 
    console.debug("allowed_commands:", allowed_commands);
    return allowed_commands.includes(cmd);
}
*/

function handleMessage(message, sender, sendResponse) {
    console.debug("received message");
    console.debug("received: ", message);
    var command = message[0];
    console.debug("command:", command);
    console.debug("from: ", sender);
    console.debug("respond on: ", sendResponse);
    //response = {errno: 0, stdout: "pong", stderr: ""};
    //sendResponse(response);
    var pid = control.newPid();
    console.debug("got pid:", pid);
    console.debug("control:", control);
    console.debug("control.setResponder:", control.setResponder);
    var responder=function(message) {
        console.debug("responder wrapper", message);
        sendResponse(message);
        console.debug("responder wrapper done");
    }
    control.setResponder(pid, sendResponse);
    control.setCommand(pid, message);
    control.setURL(pid, sender.url);
    console.debug("set responder");
    console.debug("sending message");
    control.prepare(pid);
    console.debug("sent message");
    return true;
}


startRunner();
control = new Controller();
browser.runtime.onMessage.addListener(handleMessage);
