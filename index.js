// FastCGI
//
// Copyright 2011 Iris Couch
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

// Specification: http://www.fastcgi.com/drupal/node/22

/*jshint indent: 4, undef: true, node: true */

"use strict";

var net = require('net');
var URL = require('url');
var util = require('util');
var FCGI = require('fastcgi-parser');
var cgiEnv = require('cgi-env');

var FastCGIStream = require('fcgi-stream');

module.exports = {
    connect: connect
};

function fcgi_get_values(socket, callback) {
    socket.on('data', on_data);

    var values = [
        ['FCGI_MAX_CONNS', ''],
        ['FCGI_MAX_REQS', ''],
        ['FCGI_MPXS_CONNS', '']
    ];

    var writer = new FCGI.writer();
    writer.encoding = 'binary';

    writer.writeHeader({
        version: FCGI.constants.version,
        type: FCGI.constants.record.FCGI_GET_VALUES,
        recordId: 0,
        contentLength: FCGI.getParamLength(values),
        paddingLength: 0
    });
    writer.writeParams(values);
    socket.write(writer.tobuffer());

    writer.writeHeader({
        version: FCGI.constants.version,
        type: FCGI.constants.record.FCGI_GET_VALUES,
        recordId: 0,
        contentLength: 0,
        paddingLength: 0
    });

    socket.write(writer.tobuffer());

    var fcgi_values = {};
    var timeout = setTimeout(got_all_values, 100);

    function on_data(data) {
        var parser = new FCGI.parser();
        parser.encoding = 'utf8';
        parser.onRecord = on_record;
        parser.onError  = function on_error(er) {
            this.onRecord = this.onError = function () {};
            callback(er);
        };

        parser.execute(data);
    }

    function on_record(record) {
        var params = record.body.params || {};
        var keys = Object.keys(params);

        keys.forEach(function (key) {
            fcgi_values[key] = num_or_str(params[key]);
        });

        if (keys.length === 0) got_all_values();
    }

    function got_all_values() {
        clearTimeout(timeout);
        socket.removeListener('data', on_data);
        callback(null, fcgi_values);
    }
}

function connect(options, connectListener) {
    var connection = new FCGIConnection(options);

    connection.socket.on('error', connectListener);
    connection.socket.on('connect', onConnect);

    function onConnect() {
        connection.socket.removeListener('error', connectListener);
        return connectListener(null, connection);
    }
}

function FCGIConnection(options) {
    var request_id = 0;
    var requests_in_flight = {};
    var pending_requests = [];
    var fcgi_stream = null;

    var socket = this.socket = net.connect(options);

    prep_socket();

    this.handle = function proxyToFastCGI(req, res, options) {
        request_id += 1;
        var fcgi_request = {
            id: request_id,
            req: req,
            res: res,
            options: options,
            stdout: [],
            stderr: [],
            keepalive: FCGI.constants.keepalive.OFF
        };
        pending_requests.push(fcgi_request);
        process_request();
    };

    return this;

    function process_request() {
        if (!socket) return;

        if (Object.keys(requests_in_flight).length && !options.multiplex) return;

        var fcgi_request = pending_requests.shift();
        if (!fcgi_request) return;

        requests_in_flight[fcgi_request.id] = fcgi_request;

        var req = fcgi_request.req;
        var res = fcgi_request.res;

        var cgi = cgiEnv.createEnvironment(req);

        if (fcgi_request.options.env) {
            for (var v in fcgi_request.options.env) {
                cgi[v] = fcgi_request.options.env[v];
            }
        }

        // Write the request to FastCGI.
        var writer = new FCGI.writer();
        writer.encoding = 'binary';

        // Begin
        writer.writeHeader({
            version: FCGI.constants.version,
            type: FCGI.constants.record.FCGI_BEGIN,
            recordId: fcgi_request.id,
            contentLength: 8,
            paddingLength: 0
        });
        writer.writeBegin({
            role: FCGI.constants.role.FCGI_RESPONDER,
            flags: fcgi_request.keepalive
        });
        socket.write(writer.tobuffer());

        var params = Object.keys(cgi).map(function (v) {
            return [v, cgi[v]];
        });

        // Parameters
        writer.writeHeader({
            version: FCGI.constants.version,
            type: FCGI.constants.record.FCGI_PARAMS,
            recordId: fcgi_request.id,
            contentLength: FCGI.getParamLength(params),
            paddingLength: 0
        });
        writer.writeParams(params);
        socket.write(writer.tobuffer());

        // End parameters
        writer.writeHeader({
            version: FCGI.constants.version,
            type: FCGI.constants.record.FCGI_PARAMS,
            recordId: fcgi_request.id,
            contentLength: 0,
            paddingLength: 0
        });
        socket.write(writer.tobuffer());

        // STDIN
        if (req.method != 'PUT' && req.method != 'POST') {
            end_request();
        } else {
            req.on('data', function (chunk) {
                writer.writeHeader({
                    version: FCGI.constants.version,
                    type: FCGI.constants.record.FCGI_STDIN,
                    recordId: fcgi_request.id,
                    contentLength: chunk.length,
                    paddingLength: 0
                });
                writer.writeBody(chunk);

                var data = writer.tobuffer();
                socket.write(data);
            });

            req.on('end', end_request);
        }

        function end_request() {
            writer.writeHeader({
                version: FCGI.constants.version,
                type: FCGI.constants.record.FCGI_STDIN,
                recordId: fcgi_request.id,
                contentLength: 0,
                paddingLength: 0
            });
            socket.write(writer.tobuffer());

            /* At this point the request can be considered sent to the server,
             * and it would be dangerous to re-send without knowing more
             * details.
             */
            fcgi_request.sent = true;
        }
    }

    function prep_socket() {
        fcgi_stream = new FastCGIStream();
        fcgi_stream.on('data', on_data);
        fcgi_stream.on('end', on_end);

        socket.pipe(fcgi_stream);
        process_request();
    }

    function on_end() {
        socket = null;

        var in_flight_ids = Object.keys(requests_in_flight);
        var aborts = [];

        in_flight_ids.forEach(function (in_flight_id) {
            var request_in_flight = requests_in_flight[in_flight_id];
            delete requests_in_flight[in_flight_id];

            if (request_in_flight.sent && request_in_flight.req.method != 'GET') {
                aborts.push(request_in_flight);
            } else {
                // This can be retried when FastCGI comes back on-line.
                request_in_flight.sent = false;
                pending_requests.unshift(request_in_flight);
            }
        });

        if (aborts.length) {
            aborts.forEach(function (aborted_request) {
                aborted_request.res.end();
            });
        }

        /*
        connect_fcgi(socket_path, function (er, new_socket) {
            if (er) throw er; // TODO

            socket = new_socket;
            prep_socket();
        });
        */
    }

    function on_data(data) {
        var parser = new FCGI.parser();
        parser.bodies = [];
        parser.encoding = 'binary';
        parser.onBody   = function on_body(data, start, end) {
            data = data.slice(start, end);
            this.bodies.push(data);
        };
        parser.onRecord = function on_record(record) {
            record.bodies = this.bodies;
            this.bodies = [];
            record.body_utf8 = function () {
                return this.bodies.map(function (data) {
                    return data.toString();
                }).join('');
            };

            var req_id = record.header.recordId;
            if (req_id === 0) return; // Ignore management record

            var request = requests_in_flight[req_id];
            if (!request) return; // Unknown request

            if (record.header.type == FCGI.constants.record.FCGI_STDERR) {
                return; // error('Error: %s', record.body_utf8().trim())
            } else if (record.header.type == FCGI.constants.record.FCGI_STDOUT) {
                request.stdout = request.stdout.concat(record.bodies);
                return send_stdout(request);
            } else if (record.header.type == FCGI.constants.record.FCGI_END) {
                request.res.end();
                delete requests_in_flight[req_id];

                if (request.keepalive == FCGI.constants.keepalive.ON) {
                    process_request(); // If there are more in the queue, get to them now.
                } else {
                    socket.end();
                }
            }
        };

        parser.onError  = on_error;
        parser.execute(data);
    }

    function on_error(er) {
        throw er; // TODO
    }

    function send_stdout(request) {
        if (!request.status) {
            var data_so_far = Buffer.concat(request.stdout);
            var header_break = find_header_break(data_so_far);

            if (!header_break) return; // Still waiting for all headers to arrive.

            // Headers have arrived. Convert them into a .writeHead() and only write subsequent data.
            request.stdout = [ data_so_far.slice(header_break.end, data_so_far.length) ];

            var headers_section = data_so_far.slice(0, header_break.start).toString('utf8');
            var lines = headers_section.split(/\r?\n/);
            var headers = {};

            lines.forEach(function (line) {
                var match = line.match(/^(.*?):\s(.*)$/);
                var key = match && match[1].toLowerCase();

                if (key == 'status') {
                    request.status = parseInt(match[2], 10) || 200;
                } else {
                    headers[key] = match[2];
                }
            });

            delete headers['accept-encoding'];
            request.res.writeHead(request.status ? request.status : 200, headers);
        }

        while (request.stdout.length > 0) {
            var data = request.stdout.shift();
            request.res.write(data);
        }
    }
}

//
// Utilities
//

/** Coerce number-like values to numbers */
function num_or_str(value) {
    var num_value = +value;
    return isNaN(num_value) ? value : num_value;
}

/** Search for a double line break, either unix or inet style */
function find_header_break(data) {
    var unix = new Buffer('\n\n');
    var inet = new Buffer('\r\n\r\n');

    for (var i = 0; i + 2 <= data.length; i++) {
        if (data[i] == unix[0] && data[i + 1] == unix[1]) {
            return {'start': i, 'end': i + 2};
        }
        if (data[i] == inet[0] && data[i + 1] == inet[1] && data[i + 2] == inet[2] && data[i + 3] == inet[3]) {
            return {'start': i, 'end': i + 4};
        }
    }

    return null;
}
