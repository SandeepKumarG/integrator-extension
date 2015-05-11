var nconf = require('nconf').argv().env();
if (process.env.NODE_ENV !== 'production') {
  nconf.defaults({
    'TEST_INTEGRATOR_CONNECTOR_PORT': 7000,
    "TEST_INTEGRATOR_CONNECTOR_BEARER_TOKEN": "TEST_INTEGRATOR_CONNECTOR_BEARER_TOKEN",
    "INTEGRATOR_CONNECTOR_SYSTEM_TOKEN": "TEST_INTEGRATOR_CONNECTOR_SYSTEM_TOKEN"
  });
}

var express = require('express');
var app = express();
var logger = require('winston');
var expressWinston = require('express-winston');
var bodyParser = require('body-parser');
var Promise = require('bluebird');

var connectors = {
  'dummy-connector': require('./dummy-connector')
}

if (process.env.NODE_ENV === 'production') {
  connectors['netsuite-zendesk-connector'] = require('netsuite-zendesk-connector');
}

var port = nconf.get('TEST_INTEGRATOR_CONNECTOR_PORT') || 80;

// configure logging.  pretty ugly code but dont know better way yet
var fileTransportOpts = {
  filename: './server.log',
  maxsize: 10000000,
  maxFiles: 2,
  json: false,
  handleExceptions: (process.env.NODE_ENV === 'production')
};

var consoleTransportOpts = {
  colorize: true,
  timestamp :true,
  prettyPrint: true
};

var fileTransport = new logger.transports.DailyRotateFile(fileTransportOpts);
var consoleTransport = new logger.transports.Console(consoleTransportOpts);

// Gives an error when module is installed in integrator for testing
// Add loggers only when not running as a module
if (__dirname.indexOf('node_modules') === -1) {
  logger.remove(logger.transports.Console);
  logger.add(logger.transports.Console, consoleTransportOpts);
  logger.add(logger.transports.DailyRotateFile, fileTransportOpts);
}

expressWinston.requestWhitelist.splice(0, expressWinston.requestWhitelist.length);
expressWinston.requestWhitelist.push('method');
expressWinston.requestWhitelist.push('url');
expressWinston.requestWhitelist.push('query');
var expressWinstonLogger = expressWinston.logger({
  transports: [
    fileTransport,
    consoleTransport
  ]
});
var expressWinstonErrorLogger = expressWinston.errorLogger({
  transports: [
    fileTransport,
    consoleTransport
  ]
});

// we need the logs from all our 3rd party modules.
logger.extend(console);
var log = console.log;
console.log = function hijacked_log(level) {
  if (arguments.length > 1 && level in this) {
    log.apply(this, arguments);
  } else {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('info');
    log.apply(this, args);
  }
}

app.use(bodyParser.json());
app.use(expressWinstonLogger);
app.use(expressWinstonErrorLogger);

//routes
app.get('/', function (req, res) {
  res.send('I am doing good!');
});

app.get('/healthCheck', function (req, res) {
  res.send('I am doing good!');
});

app.put('/setup', function (req, res) {
  processIntegrationRequest(req, res, 'setup');
});

app.put('/settings', function (req, res) {
  processIntegrationRequest(req, res, 'settings');
});

app.post('/function', function (req, res) {
  processIntegrationRequest(req, res, 'function');
});

function processIntegrationRequest(req, res, endpoint) {
  var errors = validateReq(req);

  if (errors.length > 0) {
    if (errors[0].code === 'unauthorized') {
      res.set('WWW-Authenticate', 'invalid system token');
      return res.status(401).json({errors: errors});
    }

    return res.status(422).json({errors: errors});
  }

  var functionName = undefined;
  var _objectId = undefined;
  var repoName = req.body.repository.name;
  var postBodyArgs = [];
  var promisifiedFunc = undefined;

  if (endpoint === 'setup') {
    _objectId = req.body._integrationId;
    if (!_objectId) {
      errors.push({field: '_integrationId', code: 'missing_required_field', message: 'missing required field in request'});
    }

    functionName = req.body.function;
    if (!functionName) {
      errors.push({field: 'function', code: 'missing_required_field', message: 'missing required field in request'});
    } else {

      if (!connectors[repoName] || !connectors[repoName].setup || !connectors[repoName].setup[functionName]) {
        errors.push({code: 'missing_function', message: functionName + ' function not found'});
      } else {
        var func = connectors[repoName].setup[functionName];
        promisifiedFunc = Promise.promisify(func);
      }
    }

    postBodyArgs.push(req.body.postBody);
  } else if (endpoint === 'settings') {
    _objectId = req.body._integrationId;
    if (!_objectId) {
      errors.push({field: '_integrationId', code: 'missing_required_field', message: 'missing required field in request'});
    }

    functionName = 'processSettings';
    if (!connectors[repoName] || !connectors[repoName][functionName]) {
      errors.push({code: 'missing_function', message: functionName + ' function not found'});
    } else {
      var func = connectors[repoName][functionName];
      promisifiedFunc = Promise.promisify(func);
    }

    postBodyArgs.push(req.body.postBody);
  } else if (endpoint === 'function') {
    if (!req.body._exportId && !req.body._importId) {
      errors.push({code: 'missing_required_field', message: '_importId or _exportId must be sent in the request'});
    } else if (req.body._exportId && req.body._importId) {
      errors.push({code: 'invalid_request', message: 'both _importId and _exportId must not be sent together'});
    } else {

      functionName = req.body.function;
      if (!functionName) {
        errors.push({field: 'function', code: 'missing_required_field', message: 'missing required field in request'});
      } else {

        if (req.body._exportId) {
          _objectId = req.body._exportId;

          if (!connectors[repoName] || !connectors[repoName].export || !connectors[repoName].export[functionName]) {
            errors.push({code: 'missing_function', message: functionName + ' function not found'});
          } else {
            promisifiedFunc = connectors[repoName].export[functionName];
          }
        } else if (req.body._importId) {
          _objectId = req.body._importId;

          if (!connectors[repoName] || !connectors[repoName].import || !connectors[repoName].import[functionName]) {
            errors.push({code: 'missing_function', message: functionName + ' function not found'});
          } else {
            promisifiedFunc = connectors[repoName].import[functionName];
          }
        }

        if (!Array.isArray(req.body.postBody)) {
          errors.push({code: 'invalid_args', message: 'postBody must be an array'});
        } else if (req.body.postBody.length === 0 || !Array.isArray(req.body.postBody[0])) {
          errors.push({code: 'invalid_args', message: 'first argument must be an array'});
        } else {
          postBodyArgs = req.body.postBody;
        }
      }
    }
  } else {
    errors.push({code: 'invalid_endpoint', message: endpoint + 'is invalid'});
  }

  if (errors.length > 0) {
    return res.status(422).json({errors: errors});
  }

  // var callback = function(err, resp) {
  //   if (err) {
  //     errors.push({code: err.name, message: err.message});
  //     return res.status(422).json({errors: errors});
  //   }
  //
  //   res.json(resp);
  // };

  var args = [req.body.bearerToken, _objectId];
  Array.prototype.push.apply(args, postBodyArgs);
  // args.push(callback);

  // func.apply(null, args);

  // var promisified = Promise.promisify(func);
  promisifiedFunc.apply(null, args).then(function(resp) {
    res.json(resp);
  }).catch(function(err) {
    errors.push({code: err.name, message: err.message});
    return res.status(422).json({errors: errors});
  });
}

function validateReq(req) {
  var errors = [];

  var systemToken = findToken(req);
  if (systemToken !== nconf.get('INTEGRATOR_CONNECTOR_SYSTEM_TOKEN')) {
    errors.push({code: 'unauthorized', message: 'invalid system token'});
    return errors;
  }

  var bearerToken = req.body.bearerToken;
  if (!bearerToken) {
    errors.push({field: 'bearerToken', code: 'missing_required_field', message: 'missing required field in request'});
  }

  if (!req.body.repository || !req.body.repository.name) {
    errors.push({field: 'repository.name', code: 'missing_required_field', message: 'missing required field in request'});
  }

  return errors;
}

var server = app.listen(port, function () {
  logger.info('integrator-connector server listening on port ' + port);
  logger.info('NODE_ENV: ' + nconf.get('NODE_ENV'));
});

function findToken(req) {
  var token;
  if (req.headers && req.headers.authorization) {
    var parts = req.headers.authorization.split(' ');
    if (parts.length == 2) {
      var scheme = parts[0]
        , credentials = parts[1];
      if (/^Bearer$/i.test(scheme)) {
        token = credentials;
      }
    }
  } else if (req.body && req.body.access_token) {
    token = req.body.access_token;
  } else if (req.query && req.query.access_token) {
    token = req.query.access_token;
  }

  return token;
}
