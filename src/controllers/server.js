'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2016 Dane Everitt <dane@daneeveritt.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const rfr = require('rfr');
const Async = require('async');
const moment = require('moment');
const _ = require('lodash');
const EventEmitter = require('events').EventEmitter;
const Querystring = require('querystring');
const Path = require('path');
const Fs = require('fs-extra');
const extendify = require('extendify');
const Util = require('util');
const Ansi = require('ansi-escape-sequences');

const Log = rfr('src/helpers/logger.js');
const Docker = rfr('src/controllers/docker.js');
const Status = rfr('src/helpers/status.js');
const ConfigHelper = rfr('src/helpers/config.js');
const Websocket = rfr('src/http/socket.js').ServerSockets;
const UploadSocket = rfr('src/http/upload.js');
const FileSystem = rfr('src/controllers/fs.js');
const SFTPController = rfr('src/controllers/sftp.js');

const SFTP = new SFTPController();
const Config = new ConfigHelper();

class Server extends EventEmitter {

    constructor(json, next) {
        super();

        this.status = Status.OFF;
        this.json = json;
        this.uuid = this.json.uuid;
        this.processData = {
            query: {},
            process: {},
        };

        this.intervals = {
            process: null,
            query: null,
        };

        this.knownWrite = false;
        this.buildInProgress = false;
        this.configLocation = Path.join(__dirname, '../../config/servers/', this.uuid, 'server.json');

        this.log = Log.child({ server: this.uuid });
        this.lastCrash = undefined;
        this.failedQueryCount = 0;

        this.docker = new Docker(this, (err, status) => {
            if (status) {
                this.log.info('Daemon detected that the server container is currently running, re-attaching to it now!');
            }
            if (err && err.statusCode === 404) { // no such container
                this.log.info('Container was not found. Attempting to recreate it.');
                next(); // Continue normal initialization
                this.rebuild((rebuildErr) => {
                    if (rebuildErr) this.log.fatal('Could not recreate container.');
                });
            } else {
                return next(err);
            }
        });

        const Service = rfr(Util.format('src/services/%s/index.js', this.json.service.type));
        this.service = new Service(this);

        this.socketIO = new Websocket(this).init();
        this.uploadSocket = new UploadSocket(this).init();
        this.fs = new FileSystem(this);
    }

    hasPermission(perm, token) {
        if (typeof perm !== 'undefined' && typeof token !== 'undefined') {
            if (!_.isUndefined(this.json.keys) && token in this.json.keys) {
                if (_.includes(this.json.keys[token], perm) || _.includes(this.json.keys[token], 's:*')) {
                    // Check Suspension Status
                    if (_.get(this.json, 'suspended', 0) === 0) {
                        return true;
                    }
                    return false;
                }
            }
        }
        return false;
    }

    setStatus(status) {
        if (status === this.status) return;
        const inverted = _.invert(Status);

        // If a user starts their server and then tries to stop it before the server is done
        // it triggers a crash condition. This logic determines if the server status is set to
        // stopping, and if so, we prevent changing the status to starting or on. This allows the
        // server to not crash when we press stop before it is compeltely started.
        if (this.status === Status.STOPPING && (status === Status.ON || status === Status.STARTING)) {
            this.log.debug(`Recieved request to mark server as ${inverted[status]} but the server is currently marked as STOPPING.`);
            return;
        }

        // Handle Internal Tracking
        if (status === Status.ON) {
            if (_.isNull(this.intervals.query)) {
                this.intervals.query = setInterval(this.query, 10000, this);
            }
            if (_.isNull(this.intervals.process)) {
                this.intervals.process = setInterval(this.process, 2000, this);
            }
        } else if (status === Status.STARTING) {
            if (_.isNull(this.intervals.process)) {
                this.intervals.process = setInterval(this.process, 2000, this);
            }

            if (!_.isNull(this.intervals.query)) {
                clearInterval(this.intervals.query);
                this.intervals.query = null;
                this.processData.query = {};
            }
        } else if (status === Status.STOPPING || status === Status.OFF) {
            if (!_.isNull(this.intervals.query) || !_.isNull(this.intervals.process)) {
                // Server is stopping or stopped, lets clear the interval as well as any stored
                // information about the process or query. Lets also detach the stats stream.
                clearInterval(this.intervals.process);
                clearInterval(this.intervals.query);
                this.intervals.process = null;
                this.intervals.query = null;
                this.failedQueryCount = 0;
                this.processData.process = {};
                this.processData.query = {};
            }
        }

        this.log.info(`Server status has been changed to ${inverted[status]}`);
        this.status = status;
        this.emit(`is:${inverted[status]}`);
        this.emit('status', status);
    }

    preflight(next) {
        // Return immediately if server is currently powered on.
        if (this.status !== Status.OFF) {
            return next(new Error('Server is already running.'));
        }
        return this.service.onPreflight(next);
    }

    start(next) {
        if (this.status !== Status.OFF) {
            return next(new Error('Server is already running.'));
        }

        if (this.json.rebuild === true || this.buildInProgress === true) {
            if (this.buildInProgress !== true) {
                Async.waterfall([
                    callback => {
                        this.buildInProgress = true;
                        this.emit('console', `${Ansi.style.cyan}(Daemon) Your server is currently queued for a container rebuild. This should only take a few seconds, but could take a few minutes. You do not need to do anything else while this occurs. Your server will automatically continue with startup once this process is completed.`);
                        callback();
                    },
                    callback => {
                        this.rebuild(callback);
                    },
                    (newServer, callback) => {
                        newServer.start(callback);
                    },
                ], err => {
                    if (err) {
                        this.emit('console', `${Ansi.style.red}(Daemon) An error was encountered while attempting to rebuild this container.`);
                        this.buildInProgress = false;
                        Log.error(err);
                    }
                });
            } else {
                this.emit('console', `${Ansi.style.cyan}(Daemon) Please wait while your server is being rebuilt.`);
            }
            return next(new Error('Server is currently queued for a container rebuild. Your request has been accepted and will be processed once the rebuild is complete.'));
        }

        Async.series([
            callback => {
                this.log.debug('Initializing for boot sequence, running preflight checks.');
                this.emit('console', `${Ansi.style.green}(Daemon) Server detected as booting.`);
                this.preflight(callback);
            },
            callback => {
                this.emit('console', `${Ansi.style.green}(Daemon) Server container started.`);
                this.docker.start(callback);
            },
            callback => {
                this.setStatus(Status.STARTING);
                this.emit('console', `${Ansi.style.green}(Daemon) Attached to server container.`);
                this.docker.attach(callback);
            },
            callback => {
                this.service.onStart(callback);
            },
        ], (err, reboot) => {
            if (err) {
                if (err.statusCode === 404) { // container not found
                    this.log.error('The container for this server could not be found. Trying to rebuild it.');
                    this.emit('console', `${Ansi.style.cyan}(Daemon) The container of this server could not be found and needs to be rebuilt.`);
                    this.modifyConfig({ rebuild: true }, false, modifyError => {
                        if (modifyError) return this.log.error('Could not modify config.');
                        this.start(_.noop); // Ignore the callback as there is nowhere to send the errors to.
                    });
                    return next(new Error('Server container was not found and needs to be rebuilt. Your request has been accepted and will be processed once the rebuild is complete.'));
                }

                this.log.error(err);
                return next(err);
            }

            if (typeof reboot !== 'undefined') {
                // @TODO: Handle the need for a reboot here.
            }
            return next();
        });
    }

    stop(next) {
        if (this.status === Status.OFF) {
            return next(new Error('Server is already stopped.'));
        }

        this.setStatus(Status.STOPPING);
        // So, technically docker sends a SIGTERM to the process when this is run.
        // This works out fine normally, however, there are times when a container might take
        // more than 10 seconds to gracefully stop, at which point docker resorts to sending
        // a SIGKILL, which, as you can imagine, isn't ideal for stopping a server.
        //
        // So, what we will do is send a stop command, and then sit there and wait
        // until the container stops because the process stopped, at which point the crash
        // detection will not fire since we set the status to STOPPING.
        this.command(this.service.object.stop, next);
    }

    kill(next) {
        if (this.status === Status.OFF) {
            return next(new Error('Server is already stopped.'));
        }

        this.setStatus(Status.STOPPING);
        this.docker.kill(err => {
            this.setStatus(Status.OFF);
            return next(err);
        });
    }

    restart(next) {
        Async.series([
            callback => {
                if (this.status !== Status.OFF) {
                    this.once('is:OFF', callback);
                    this.stop(err => {
                        if (err) return callback(err);
                    });
                } else {
                    return callback();
                }
            },
            callback => {
                this.start(callback);
            },
        ], next);
    }

    /**
     * Send output from server container to websocket.
     */
    output(output) {
        this.service.onConsole(output);
    }

    /**
     * Send command to server.
     */
    command(command, next) {
        if (this.status === Status.OFF) {
            return next(new Error('Server is currently stopped.'));
        }

        // Prevent a user sending a stop command manually from crashing the server.
        if (command.trim().replace(/^\/*/, '').startsWith(this.service.object.stop)) {
            this.setStatus(Status.STOPPING);
        }

        this.docker.write(command, next);
    }

    /**
     * Determines if the container stream should have ended yet, if not, mark server crashed.
     */
    streamClosed() {
        if (this.status === Status.OFF || this.status === Status.STOPPING) {
            this.setStatus(Status.OFF);
            return;
        }

        if (!_.get(this.json, 'container.crashDetection', true)) {
            this.setStatus(Status.OFF);
            this.log.warn('Server detected as potentially crashed but crash detection has been disabled on this server.');
            return;
        }

        this.emit('crashed');
        this.setStatus(Status.OFF);
        if (moment.isMoment(this.lastCrash)) {
            if (moment(this.lastCrash).add(60, 'seconds').isAfter(moment())) {
                this.setCrashTime();
                this.log.warn('Server detected as crashed but has crashed within the last 60 seconds, aborting reboot.');
                this.emit('console', `${Ansi.style.red}(Daemon) Server detected as crashed! Unable to reboot due to crash within last 60 seconds.`);
                return;
            }
        }

        this.log.warn('Server detected as crashed! Attempting server reboot.');
        this.emit('console', `${Ansi.style.red}(Daemon) Server detected as crashed! Attempting to reboot server now.`);
        this.setCrashTime();

        this.start(err => {
            if (err) this.log.fatal(err);
        });
    }

    setCrashTime() {
        this.lastCrash = moment();
    }

    path(location) {
        const dataPath = Path.join(Config.get('sftp.path', '/srv/data'), this.json.user, '/data');
        let returnPath = dataPath;

        if (typeof location !== 'undefined' && location.replace(/\s+/g, '').length > 0) {
            returnPath = Path.join(dataPath, Path.normalize(Querystring.unescape(location)));
        }

        // Path is good, return it.
        if (returnPath.startsWith(dataPath)) {
            return returnPath;
        }
        return dataPath;
    }

    // Still using self here because of intervals.
    query(self) { // eslint-disable-line
        if (self.status !== Status.ON) return;

        self.service.doQuery((err, response) => {
            if (err) {
                // Only report error once, otherwise don't spam up the display.
                if (self.failedQueryCount === 0) {
                    self.log.warn(`${err.message} -- Additional query errors will not display unless there is a successful query.`);
                    self.service.onConsole(`${Ansi.style.magenta}(Daemon) ${err.message} -- Additional query errors will not display unless there is a successful query.\n`);
                }

                self.failedQueryCount++; // eslint-disable-line
                if (Config.get('query.kill_on_fail', false) && self.failedQueryCount > Config.get('query.fail_limit', 3)) {
                    self.service.onConsole(`${Ansi.style.magenta}(Daemon) Server has reached maximum consecutive query failure limit (n = ${Config.get('query.fail_limit', 3)}) and has been marked as crashed.\n`);
                    self.docker.kill(killErr => {
                        if (killErr) return self.log.fatal(killErr);
                    });
                    self.failedQueryCount = 0; // eslint-disable-line
                }
            } else {
                self.failedQueryCount = 0; // eslint-disable-line
            }

            self.processData.query = { // eslint-disable-line
                name: _.get(response, 'name', null),
                map: _.get(response, 'map', null),
                maxplayers: _.get(response, 'maxplayers', null),
                players: _.get(response, 'players', null),
                bots: _.get(response, 'bots', null),
                raw: _.get(response, 'raw', {}),
                error: _.get(err, 'message', false),
            };
            self.emit('query', self.processData.query);
        });
    }

    process(self) { // eslint-disable-line
        if (self.status === Status.OFF) return;

        // When the server is started a stream of process data is begun
        // which is stored in Docker.procData. We wilol now access that
        // and process it.
        if (_.isUndefined(self.docker.procData)) return;

        // We need previous cycle information as well.
        if (_.isUndefined(self.docker.procData.precpu_stats.cpu_usage)) return;

        const perCoreUsage = [];
        const priorCycle = self.docker.procData.precpu_stats;
        const cycle = self.docker.procData.cpu_stats;

        const deltaTotal = cycle.cpu_usage.total_usage - priorCycle.cpu_usage.total_usage;
        const deltaSystem = cycle.system_cpu_usage - priorCycle.system_cpu_usage;
        const totalUsage = (deltaTotal / deltaSystem) * cycle.cpu_usage.percpu_usage.length * 100;

        Async.forEachOf(cycle.cpu_usage.percpu_usage, (cpu, index, callback) => {
            if (priorCycle.cpu_usage.percpu_usage !== null && index in priorCycle.cpu_usage.percpu_usage) {
                const priorCycleCpu = priorCycle.cpu_usage.percpu_usage[index];
                const deltaCore = cpu - priorCycleCpu;
                perCoreUsage.push(parseFloat(((deltaCore / deltaSystem) * cycle.cpu_usage.percpu_usage.length * 100).toFixed(3).toString()));
            }
            callback();
        }, () => {
            self.processData.process = { // eslint-disable-line
                memory: {
                    total: self.docker.procData.memory_stats.usage,
                    cmax: self.docker.procData.memory_stats.max_usage,
                    amax: self.json.build.memory * 1000000,
                },
                cpu: {
                    cores: perCoreUsage,
                    total: parseFloat(totalUsage.toFixed(3).toString()),
                },
            };
            self.emit('proc', self.processData.process);
        });
    }

    // If overwrite = true (PUT request) then the JSON is simply replaced with the new object keys
    // while keeping any that are not listed. If overwrite = false (PATCH request) then only the
    // specific data keys that exist are changed or added. (see _.extend documentation).
    modifyConfig(object, overwrite, next) {
        if (_.isFunction(overwrite)) {
            next = overwrite; // eslint-disable-line
            overwrite = false; // eslint-disable-line
        }

        const deepExtend = extendify({
            inPlace: false,
            arrays: 'replace',
        });
        const newObject = (overwrite === true) ? _.assignIn(this.json, object) : deepExtend(this.json, object);

        // Ports are a pain in the butt.
        if (!_.isUndefined(newObject.build)) {
            _.forEach(newObject.build, (obj, ident) => {
                if (ident.endsWith('|overwrite')) {
                    const item = ident.split('|')[0];
                    newObject.build[item] = obj;
                    delete newObject.build[ident];
                }
            });
        }

        // Do a quick determination of wether or not we need to process a rebuild request for this server.
        // If so, we need to append that action to the object that we're writing.
        const checkForRebuild = _.omit(object.build, ['cpu', 'swap', 'io', 'memory', 'disk']);
        if (!_.isUndefined(object.build) && !_.isEmpty(checkForRebuild)) {
            newObject.rebuild = true;
        }

        // Update 127.0.0.1 to point to the docker0 interface.
        if (newObject.build.default.ip === '127.0.0.1') {
            newObject.build.default.ip = Config.get('docker.interface');
        }

        _.forEach(newObject.build.ports, (ports, ip) => {
            if (ip === '127.0.0.1') {
                newObject.build.ports[Config.get('docker.interface')] = ports;
                delete newObject.build.ports[ip];
            }
        });

        Async.series([
            callback => {
                this.knownWrite = true;
                callback();
            },
            callback => {
                Fs.writeJson(this.configLocation, newObject, err => {
                    if (!err) this.json = newObject;
                    return callback(err);
                });
            },
            callback => {
                if (!_.isUndefined(object.build) && _.isEmpty(checkForRebuild)) {
                    this.updateCGroups(callback);
                } else {
                    return callback();
                }
            },
            callback => {
                if (newObject.rebuild && object.rebuild !== true) {
                    this.log.info('Server has been queued for a container rebuild on next boot.');
                } else if (newObject.rebuild && object.rebuild) {
                    this.log.debug('Server is already queued for a rebuild on next boot.');
                }
                callback();
            },
        ], err => {
            if (err) this.knownWrite = false;
            return next(err);
        });
    }

    updateCGroups(next) {
        this.log.debug('Updating some build parameters without triggering a container rebuild.');
        this.emit('console', `${Ansi.style.yellow}(Daemon) Your server has had some resource limits modified, you may need to restart to apply them.\n`);
        this.docker.update(next);
    }

    rebuild(next) {
        // You shouldn't really be able to make it this far without this being set,
        // but for the sake of double checking...
        if (this.buildInProgress !== true) this.buildInProgress = true;
        Async.waterfall([
            callback => {
                this.log.debug('Running rebuild for server...');
                this.docker.rebuild((err, data) => {
                    callback(err, data);
                });
            },
            (data, callback) => {
                this.log.debug('New container created successfully, updating config...');
                this.modifyConfig({
                    rebuild: false,
                    container: {
                        id: data.id.substr(0, 12),
                        image: data.image,
                    },
                }, callback);
            },
            callback => {
                const InitializeHelper = rfr('src/helpers/initialize.js').Initialize;
                const Initialize = new InitializeHelper();
                Initialize.setup(this.json, err => {
                    if (err) return callback(err);

                    // If we don't do this we end up continuing to use the old server
                    // object for things which causes issues since not all the functions
                    // get updated.
                    const Servers = rfr('src/helpers/initialize.js').Servers;
                    return callback(err, Servers[this.json.uuid]);
                });
            },
            (server, callback) => {
                this.buildInProgress = false;
                callback(null, server);
            },
        ], (err, server) => {
            next(err, server);
        });
    }

    setPassword(password, next) {
        SFTP.password(this.json.user, password, next);
    }

    suspend(next) {
        Async.parallel([
            callback => {
                this.modifyConfig({ suspended: 1 }, callback);
            },
            callback => {
                if (this.status !== Status.OFF) {
                    return this.kill(callback);
                }
                return callback();
            },
            callback => {
                SFTP.lock(this.json.user, callback);
            },
        ], err => {
            if (!err) {
                this.log.warn('Server has been suspended.');
            }
            return next(err);
        });
    }

    unsuspend(next) {
        Async.parallel([
            callback => {
                this.modifyConfig({ suspended: 0 }, callback);
            },
            callback => {
                SFTP.unlock(this.json.user, callback);
            },
        ], err => {
            if (!err) {
                this.log.info('Server has been unsuspended.');
            }
            return next(err);
        });
    }

}

module.exports = Server;
