// FCGI stream
//
// Copyright 2012 Iris Couch
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

// Chop a data stream (of buffers) on FastCGI record boundaries.

/*jshint indent: 4 */

var util = require('util');
var stream = require('stream');

module.exports = FastCGIStream;


util.inherits(FastCGIStream, stream);
function FastCGIStream(opts) {
    var self = this;
    stream.call(self);

    opts = opts || {};
    self.log = opts.log || console;

    self.readable = true;
    self.writable = true;
    self.is_ending = false;
    self.is_sending = true;
    self.pending_data = [];
    self.records = [];

    self.source = null;
    self.once('pipe', function (src) {
        self.source = src;
        self.on('pipe', function (src) {
            var er = new Error('Already have a pipe source');
            er.source = self.source;
            self.error(er);
        });
    });
}


//
// Readable stream API
//

FastCGIStream.prototype.setEncoding = function (encoding) {
    var self = this;
    throw new Error('setEncoding not allowed, only Buffer is supported'); // TODO: Maybe "hex" encoding?
};


FastCGIStream.prototype.pause = function () {
    this.is_sending = false;

    if (this.source && this.source.pause) {
        this.source.pause();
    }
};


FastCGIStream.prototype.resume = function () {
    this.is_sending = true;
    if (this.source && this.source.resume) {
        this.source.resume();
    }
    this.emit_records();
};

//
// Writable stream API
//

FastCGIStream.prototype.write = function (data, encoding) {
    if (data) {
        this.pending_data.push(data);
    }
    this.build_record();

    return !this.is_ending;
};


FastCGIStream.prototype.build_record = function () {
  // The first buffer must at least be a complete header, or nothing can be done.
    while (this.pending_data.length > 1 && this.pending_data[0].length < 8) {
        var first_chunk = this.pending_data.shift();
        var second_chunk = this.pending_data.shift();
        this.pending_data.unshift(Buffer.concat([first_chunk, second_chunk]));
    }

    var pending_bytes = this.pending_data.reduce(function (len, buf) { return len + buf.length; }, 0);

    if (pending_bytes < 8) {
        return this.emit_records(); // No more data to process; emit any completed records.
    }

    var header = get_header(this.pending_data[0]);

    var record_bytes = 8 + header.body_len + header.pad_len; // The header itself + content + padding
    if (pending_bytes < record_bytes) {
        return this.emit_records();
    }

    // At this point, an entire record's worth of data is in the pending queue.
    var record = new Buffer(record_bytes);
    var offset = 0;

    while (offset < record_bytes) {
        var bytes_needed = record_bytes - offset;
        var next_chunk = this.pending_data.shift();

        if (next_chunk.length <= bytes_needed) {
            // This chunk entirely belongs in the record.
            next_chunk.copy(record, offset, 0, next_chunk.length);
            offset += next_chunk.length;
        } else {
            // This chunk completes the record and has data left over.
            next_chunk.copy(record, offset, 0, bytes_needed);
            offset += bytes_needed;
            var partial_chunk = next_chunk.slice(bytes_needed);
            this.pending_data.unshift(partial_chunk);
        }
    }

    this.records.push(record);

    // Run again, to perhaps build up another record (and ultimately emit them).
    this.build_record();
};

FastCGIStream.prototype.end = function (data, encoding) {
    this.is_ending = true;
    this.writable = false;

    // Always call write, even with no data, so it can fire the "end" event.
    this.write(data, encoding);

    if (this.pending_data.length) {
        if (self.pending_data[0].length >= 8) {
            get_header(self.pending_data[0]);
        }
    }
};

FastCGIStream.prototype.emit_records = function () {
    while (this.is_sending && this.records.length > 0) {
        var record = this.records.shift();
        this.emit('data', record);
    }

    // React to possible end-of-data from the source stream.
    if (this.is_sending && this.is_ending && this.records.length === 0) {
        this.is_ending = false;
        this.readable = false;
        this.emit('end');
    }
};

//
// Readable/writable stream API
//

FastCGIStream.prototype.destroy = function () {
    this.is_dead = true;
    this.is_ending = false;
    this.is_sending = false;

    if (this.source && typeof this.source.destroy === 'function') {
        this.source.destroy();
    }
};

FastCGIStream.prototype.destroySoon = function () {
    throw new Error('not implemented');
};

//
// Internal implementation
//

FastCGIStream.prototype.normalize_data = function (data, encoding) {
    if (data instanceof Buffer) {
        data = data.toString(encoding);
    } else if (typeof data === 'undefined' && typeof encoding === 'undefined') {
        data = "";
    }

    if (typeof data != 'string') {
        return this.error(new Error('Not a string or Buffer: ' + util.inspect(data)));
    }

    if (this.feed !== 'continuous' && this.feed !== 'longpoll') {
        return this.error(new Error('Must set .feed to "continuous" or "longpoll" before writing data'));
    }

    if (this.expect === null) {
        /// @todo this was where longpoll stuff lived
        this.expect = '';
    }

    var prefix = data.substr(0, this.expect.length);
    data = data.substr(prefix.length);

    var expected_part = this.expect.substr(0, prefix.length);
    var expected_remainder = this.expect.substr(expected_part.length);

    if (prefix !== expected_part) {
        return this.error(new Error('Prefix not expected ' + util.inspect(expected_part) + ': ' + util.inspect(prefix)));
    }

    this.expect = expected_remainder;
    return data;
};


FastCGIStream.prototype.error = function (er) {
    this.readable = false;
    this.writable = false;
    this.emit('error', er);

    // The write() method sometimes returns this value, so if there was an error, make write() return false.
    return false;
};

//
// Utilities
//

function get_header(chunk) {
    return {
        version: chunk.readUInt8(0),
        type: chunk.readUInt8(1),
        req_id: chunk.readUInt16BE(2),
        body_len: chunk.readUInt16BE(4),
        pad_len: chunk.readUInt8(6),
        reserved: chunk.readUInt8(7)
    };
}
