'use strict';

var path = require('path');
var caller = require('caller');
var express = require('express');
var thing = require('core-util-is');
var debug = require('debuglog')('meddleware');
var RQ = require('./rq');
var util = require('./util');


/**
 * Creates a middleware resolver based on the provided basedir.
 * @param basedir the directory against which to resolve relative paths.
 * @returns {Function} a the implementation that converts a given spec to a middleware function.
 */
function resolvery(basedir) {
  return async function resolve(spec, name) {
    var fns, fn;

    if (!spec.enabled && 'enabled' in spec) {
      return;
    }

    spec.name = spec.name || name;

    if (spec.parallel) {
      fns = util.mapValues(spec.parallel, resolve);
      fns = await Promise.all(fns);
      fn = middleware(RQ.parallel, fns);

    } else if (spec.race) {
      fns = util.mapValues(spec.race, resolve);
      fns = await Promise.all(fns);
      fn = middleware(RQ.race, fns);

    } else if (spec.fallback) {
      fns = util.mapValues(spec.fallback, util.nameObject);
      fns = fns.filter(thing.isObject).sort(compare);
      fns = util.mapValues(fns, resolve);
      fns = await Promise.all(fns);
      fn = middleware(RQ.fallback, fns);

    } else {
      fn = resolveImpl(basedir, spec.module);
    }

    return await fn;
  };
}

/**
 * Attempts to find the best method given the config and ES5/ES6 module patterns
 */
function findModuleMethod(config, module) {
  // First, look for a factory method in the config
  if (config.method) {
    if (module[config.method] && thing.isFunction(module[config.method])) {
      // Straight named export
      return module[config.method];
    } else if (module.default && thing.isObject(module.default)) {
      // ES6 default export of an object with a method property which is a fn
      return module.default[config.method];
    }
  } else if (thing.isFunction(module)) {
    // Regular module.exports = fn
    return module;
  } else if (module.default && thing.isFunction(module.default)) {
    // ES6 export default fn
    return module.default;
  }
}

/**
 * Attempts to load a node module by name
 */
function findModule(root, config) {
  var modulePath;

  if (!config.name) {
    throw new TypeError('Module name not defined in middleware config: ' + JSON.stringify(config));
  }

  debug('loading module', config.name);

  // Check the initial module, then try to resolve it to an absolute path and check again.
  modulePath = util.tryResolve(config.name) || util.tryResolve(path.resolve(root, config.name));

  // If modulePath was not resolved lookup with config.name for meaningful error message.
  return require(modulePath || config.name);
}

/**
 * Attempts to locate a node module and get the specified middleware implementation.
 * @param root The root directory to resolve to if file is a relative path.
 * @param config The configuration object, string or function describing the module. If the
 * config is an object, the factory method will be defined by either 'factory' (must be a function)
 * or resolving the name and method properties.
 * @returns {Function} The middleware implementation, if located.
 */
function resolveImpl(root, config) {
  var module, factory, args;

  if (typeof config === 'function') {
    return config();
  }

  if (typeof config === 'string') {
    return resolveImpl(root, { name: config });
  }

  if (!config) {
    throw new TypeError("No module section given in middleware entry");
  }

  if (config.factory && typeof config.factory === 'function') {
    factory = config.factory;
    if (!config.name) {
      // if there was no name set, use the factory name
      config.name = factory.name;
    }
  } else {
    module = findModule(root, config);

    factory = findModuleMethod(config, module);
    if (!thing.isFunction(factory)) {
      throw new Error('Unable to locate middleware in ' + config.name);
    }
  }

  args = thing.isArray(config['arguments']) ? config['arguments'] : [];
  return factory.apply(module, args);
}



/**
 * Middleware Factory
 * @param requestory
 * @param fns
 * @returns {Function}
 */
function middleware(requestory, fns) {
  fns = fns.filter(function (fn) { return !!fn; });
  var rq = requestory(fns.map(taskery));
  return function composite(req, res, next) {
    function complete(success, failure) {
      next(failure);
    }
    rq(complete, { req: req, res: res });
  };
}


/**
 * Task Factory
 * @param fn
 * @returns {Function}
 */
function taskery(fn) {
  return function requestor(requestion, value) {
    if (typeof fn !== 'function') {
      console.error(fn);
    }
    fn(value.req, value.res, function (err) {
      requestion(null, err);
    });
  };
}


/**
 * Comparator for sorting middleware by priority
 * @param a
 * @param b
 * @returns {number}
 */
function compare(a, b) {
  var ap, bp;
  ap = typeof a.priority === 'number' ? a.priority : Number.MIN_VALUE;
  bp = typeof b.priority === 'number' ? b.priority : Number.MIN_VALUE;
  return ap - bp;
}


/**
 * Normalize string routes
 * @param mountpath
 * @param route
 * @returns {string}
 */
function normalize(mountpath, route) {

  if (thing.isRegExp(route) || Array.isArray(route)) {
    // we cannot normalize regexes and arrays
    return route;
  }

  if (thing.isString(route)) {
    mountpath += mountpath[mountpath.length - 1] !== '/' ? '/' : '';
    mountpath += route[0] === '/' ? route.slice(1) : route;
  }

  return mountpath;
}

async function meddlewareImpl(settings, basedir) {
  const resolve = resolvery(basedir);

  const toCreate = util
    .mapValues(settings, util.nameObject)
    .filter(thing.isObject)
    .sort(compare);
  const toRegister = [];
  for (const spec of toCreate) {
    const fn = await resolve(spec, spec.name);
    if (fn) {
      toRegister.push({ fn, spec });
    }
  }

  function onmount(parent) {
    var resolve, mountpath;

    // Remove the sacrificial express app.
    parent._router.stack.pop();

    resolve = resolvery(basedir);
    mountpath = app.mountpath;

    for (const { fn, spec } of toRegister) {
      const eventargs = { app: parent, config: spec };

      let route;
      if (thing.isArray(spec.route)) {
        route = spec.route.map(function (route) {
          return normalize(mountpath, route);
        });
      } else {
        route = normalize(mountpath, spec.route);
      }

      debug('registering', spec.name, 'middleware');

      parent.emit('middleware:before', eventargs);
      parent.emit('middleware:before:' + spec.name, eventargs);
      parent.use(route, fn);
      parent.emit('middleware:after:' + spec.name, eventargs);
      parent.emit('middleware:after', eventargs);
    }
  }

  const app = express();
  app.once('mount', onmount);
  return app;
}

export default function meddleware(settings) {
  // The `require`-ing module (caller) is considered the `basedir`
  // against which relative file paths will be resolved.
  // Don't like it? Then pass absolute module paths. :D
  const basedir = path.dirname(caller());
  return meddlewareImpl(settings, basedir);
}
