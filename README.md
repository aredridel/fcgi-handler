# FastCGI Handler for Node.js

**fcgi-handler** is a simple request handler to pass HTTP requests to a FastCGI backend.

Install it with [npm][npm]:

    npm install fcgi-handler

## Usage

Suppose you have a FastCGI application (e.g. Django) listening on Unix socket `/opt/myapp/socket`. You can connect that into your application with something like:

    var http = require('http');
    var http = require('fcgi-handler');

    http.createServer(function(req, res) {
        // Do something with routing here, probably, then:
        fcgi.connect({path: '/opt/myapp/socket'}, function(err, f) {
            if (err) handleError();
            f.handle(req, res, {env: {
                DOCUMENT_ROOT: "your document root",
                SCRIPT_FILENAME: "A script filename"
            }});
        });
    });


## License

Apache 2.0

[npm]: http://npmjs.org

## Credits

This is all based on the IrisCouch [FastCGI module][fastcgi] maintained by Jason Smith ([@_jhs][@_jhs]), but I took a machete to it [@substack][@substack]-style.

[fastcgi]: http://npmjs.org/package/fastcgi
[@_jhs]: http://twitter.com/_jhs
[@substack]: http://twitter.com/substack
