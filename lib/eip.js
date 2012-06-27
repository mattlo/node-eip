var util = require('util'),
	async = require('async'),
	stats = require('./defaultStatisticHandler'),
	eipUtil = require('./util.js').Util;

var config = {
		route: {
			retryLimit: 3,
			retryDelay: 1000,
			statisticHandler: new stats.StatisticHandler()
		},
		processor: {
			
		}
};

exports.config = config;


_routeCounter = 1;
Route = function() {
	var name, options;
	for (var i = 0; i < arguments.length; i++) {
		if (typeof(arguments[i]) === "string")
			name = arguments[i];
		else
			options = arguments[i];
	}

	var self = this;
	this.name = name || "Route" + _routeCounter++;
	this.options = options || {};
	this.processors = [];
	this.sync = this.options.sync;
	if (!this.options.isErrorRoute) {
		this.errorRoute =
			new Route(this.name + ".Errorroute", {isErrorRoute: true, sync: true})
				.error()
				.error("Stacktrace: ${headers._exception.cause.stack}.");

	}
	return this;
};

exports.Route = Route;

Route.prototype.inject = function(event) {
	if (this.processors.length == 0) {
		return this;
	}
	config.route.statisticHandler.eventInjected(this);
	this.sendEventToProcessor(this.processors[0], eipUtil.createEvent(event));
	return this;
};

Route.register = function(name, processor) {
	Route.prototype[name] = function() {
		var route = this,
			proc = new processor();
		proc.route = this;
		proc.name = name;
		proc.init.apply(proc, eipUtil.argsToArray(arguments));
		this.processors.push(proc);
		if (this.processors.length > 1) {
			var previousProc = this.processors[this.processors.length - 2];
			previousProc.next = proc;
			proc.previous = previousProc;
		}
		proc.id = route.name + "#" + this.processors.length + "(" + proc.name + ")";
		return this;
	};
};

Route.prototype.dispatchEvent = function(processor, err, event) {
	event = eipUtil.createEvent(event);
	config.route.statisticHandler.eventEmittedByProcessor(this, processor);
	if (err) {
		if (!event.headers._exception)
			event.headers._exception = {numberOfAttempts: 0};
		event.headers._exception.cause = err;
		event.headers._exception.timestamp = new Date();
		event.headers._exception.numberOfAttempts += 1;
		event.headers._exception.processor = processor.id;
		console.log("Error occured for event %s\n Number of attempts: %d; error: %s.",
			util.inspect(event, false, 2), event.headers._exception.numberOfAttempts, err);
		
		var retryLimit = config.route.retryLimit;
		if (event.headers._exception.numberOfAttempts < retryLimit) {
			var self = this;
			var delay = config.route.retryDelay;
			console.log("Retry limit not reached, try again in %d ms.", delay);
			setTimeout(function() {
				self.sendEventToProcessorSync(processor, event);
			}, delay);
		} else {
			if (this.errorRoute) {
				console.warn("Retry limit of %d reached, send event to error route. Event: %j", retryLimit, event);
				this.errorRoute.inject(event);
			} else {
				console.error("Unrecoverable error in error route, give up processing event %j.", event);
			}
		}
	} else {
		if (processor.next)
			this.sendEventToProcessor(processor.next, event);
	}
};

Route.prototype.sendEventToProcessor = function(processor, event) {
	if (this.sync) {
		this.sendEventToProcessorSync(processor, event);
	} else {
		var self = this;
		process.nextTick(function() {
			self.sendEventToProcessorSync(processor, event);
		});
	}
};

/** Immediately sends an event to a processor.
 * @private
 */
Route.prototype.sendEventToProcessorSync = function(processor, event) {
	try {
		config.route.statisticHandler.eventReceivedByProcessor(this, processor);
		processor.data.apply(processor, [event]);
	} catch (err) {
		this.dispatchEvent(processor, err, event);
	}
};

/** Shuts down all processors in this route.
 * TODO Route.inject possible after shutdown? States for routes like "shutting down"?
 * @param callback A callback which is called when all processors have been shut down or if an error occurred. 
 */
Route.prototype.shutDown = function(callback) {
	var self = this;
	async.forEachSeries(this.processors, function(processor, cb) {
		processor.shutDown(cb);
	}, function(err) {
		if (callback)
			callback(err);
	});
};

// EventEmitter
var Processor = function() {};
exports.Processor = Processor;
Processor.prototype.init = function() {};
Processor.prototype.shutDown = function(callback) {
//	console.log("Shutting down processor %s.", this.id);
	callback();
};
Processor.prototype.emitEvent = function() {
	var err, event;
	if (arguments.length == 1) {
		event = arguments[0];
	} else if (arguments.length == 2) {
		err = arguments[0];
		event = arguments[1];
	} else {
		throw new Error("Processor.emitEvent has been called with wrong parameters");
	}
	this.route.dispatchEvent(this, err, event);
};


// Map
var Mapper = function() {};
util.inherits(Mapper, Processor);
Route.register("process", Mapper);
Mapper.prototype.init = function(map) {
	this.map = map;
};
Mapper.prototype.data = function(event) {
	var self = this;
	var callback = function() {
		self.emitEvent.apply(self, eipUtil.argsToArray(arguments));
	}
	this.map.apply(this, [event, callback]);
};


//Dispatcher
var Dispatcher = function() {};
util.inherits(Dispatcher, Processor);
Route.register("dispatch", Dispatcher);
Dispatcher.prototype.init = function() {
	this.routes = eipUtil.argsToArray(arguments);
};
Dispatcher.prototype.data = function(event) {
	this.routes.forEach(function(route) {
		route.inject(event);
	});
	this.emitEvent(event);
};

//Choice
var Choice = function() {};
util.inherits(Choice, Processor);
Route.register("choice", Choice);
Choice.prototype.init = function(choice, routes) {
	var route, i;
	this.choice = choice;
	this.routes = [];
	for (i in routes) {
		route = routes[i];
		if (route.otherwise) {
			this.otherwise = route.otherwise;
		} else {
			this.routes.push(route);
		}
	}
};
Choice.prototype.data = function(event) {
	var r, when,
		routeFound = false,
		choice = eipUtil.evalRHS(event, this.choice);
	for (r in this.routes) {
		when = this.routes[r].when;
		if (choice === when) {
			this.routes[r].route.inject(event);
			routeFound = true;
		}
	}
	if (!routeFound && this.otherwise) {
		this.otherwise.inject(event);
	}
	this.emitEvent(event);
};

//Arraysink
var ArraySink = function() {};
util.inherits(ArraySink, Processor);
Route.register("toArray", ArraySink);
ArraySink.prototype.init = function(array) {
	this.array = array;
};
ArraySink.prototype.data = function(event) {
	this.array.push(event);
	this.emitEvent(event);
};

//Eval
var Eval = function() {};
util.inherits(Eval, Processor);
Route.register("eval", Eval);
Eval.prototype.init = function(code) {
	this.code = code;
};
Eval.prototype.data = function(event) {
	with (event) {
		eval(this.code)
	}
	this.emitEvent(event);
};

//Filter
var Filter = function() {};
util.inherits(Filter, Processor);
Route.register("filter", Filter);
Filter.prototype.init = function(condition) {
	this.condition = condition;
};
Filter.prototype.data = function(event) {
	if (eipUtil.evalRHS(event, this.condition)) {
		this.emitEvent(event);
	}
};



var aggregator = require("./aggregator");
exports.aggregator = aggregator;
Route.register("aggregate", aggregator.Aggregator);

exports.util = eipUtil;

require("./logger/default");
require('./el/templating');
require("./smtp");
require("./throttler");
require("./databases/mongo");



var globalErrorRoute = 
	new Route({isErrorRoute: true})
		.fatal()
		.fatal("Stacktrace: ${headers._exception.cause.stack}.");

exports.globalErrorRoute = globalErrorRoute;

process.on('uncaughtException', function (err) {
	console.error("An uncaught exception occured! If possible, the error will be sent to the global error route.");
	console.error("Error: " + err);
	if (err.stack) {
		console.error(err.stack);
	}
	if (globalErrorRoute) {
		var event = eipUtil.createEvent("Uncaught exception.");
		event.headers._exception = {cause: err, timestamp: new Date()};
		globalErrorRoute.inject(event);
	} else {
		console.log("About to exit");
		process.exit(8);
	}
});
