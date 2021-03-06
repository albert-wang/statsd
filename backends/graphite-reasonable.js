/*
 * Flush stats to graphite (http://graphite.wikidot.com/).
 *
 * To enable this backend, include 'graphite' in the backends
 * configuration array:
 *
 *   backends: ['graphite-reasonable']
 *
 * This backend supports the following config options:
 *
 *   graphiteHost: Hostname of graphite server.
 *   graphitePort: Port to contact graphite server at.
 *
 * This backend is functionally identical to the graphite backend, 
 * except that it does not scatter keys all over the place.
 *
 *
 * The key schema is preserved, given a key, then the 
 * data will be placed, depending on the type of data, in the following
 * graphite keys:
 *
 * Counters: 
 *  <key>.per_second
 *  <key>.total
 */

var net = require('net'),
   util = require('util');

var debug;
var flushInterval;
var graphiteHost;
var graphitePort;

var graphiteStats = {};

var post_stats = function graphite_post_stats(statString) {
  var last_flush = graphiteStats.last_flush || 0;
  var last_exception = graphiteStats.last_exception || 0;
  if (graphiteHost) {
    try {
      var graphite = net.createConnection(graphitePort, graphiteHost);
      graphite.addListener('error', function(connectionException){
        if (debug) {
          util.log(connectionException);
        }
      });

      graphite.on('connect', function() {
        var ts = Math.round(new Date().getTime() / 1000);
        statString += 'stats.statsd.graphiteStats.last_exception ' + last_exception + ' ' + ts + "\n";
        statString += 'stats.statsd.graphiteStats.last_flush ' + last_flush + ' ' + ts + "\n";
        this.write(statString);
        this.end();
        graphiteStats.last_flush = Math.round(new Date().getTime() / 1000);
      });
    } catch(e){
      if (debug) {
        util.log(e);
      }
      graphiteStats.last_exception = Math.round(new Date().getTime() / 1000);
    }
  }
}

var flush_stats = function graphite_flush(ts, metrics) {
  var starttime = Date.now();
  var statString = '';
  var numStats = 0;
  var key;

  var counters = metrics.counters;
  var gauges = metrics.gauges;
  var timers = metrics.timers;
  var sets = metrics.sets;
  var pctThreshold = metrics.pctThreshold;

  for (key in counters) {
    var value = counters[key];
    var valuePerSecond = value / (flushInterval / 1000); // calculate "per second" rate

    statString += 'stats.counters.' + key + '.per_second ' + valuePerSecond + ' ' + ts + "\n";
    statString += 'stats.counters.' + key + '.total ' + value          + ' ' + ts + "\n";

    numStats += 1;
  }

  for (key in timers) {
    if (timers[key].length > 0) {
      var values = timers[key].sort(function (a,b) { return a-b; });
      var count = values.length;
      var min = values[0];
      var max = values[count - 1];

      var cumulativeValues = [min];
      for (var i = 1; i < count; i++) {
          cumulativeValues.push(values[i] + cumulativeValues[i-1]);
      }

      var sum = min;
      var mean = min;
      var maxAtThreshold = max;

      var message = "";

      var key2;

      for (key2 in pctThreshold) {
        var pct = pctThreshold[key2];
        if (count > 1) {
          var numInThreshold = Math.round(pct / 100 * count);

          maxAtThreshold = values[numInThreshold - 1];
          sum = cumulativeValues[numInThreshold - 1];
          mean = sum / numInThreshold;
        }

        var clean_pct = '' + pct;
        clean_pct.replace('.', '_');
        message += 'stats.timers.' + key + '.mean_'  + clean_pct + ' ' + mean           + ' ' + ts + "\n";
        message += 'stats.timers.' + key + '.upper_' + clean_pct + ' ' + maxAtThreshold + ' ' + ts + "\n";
        message += 'stats.timers.' + key + '.sum_' + clean_pct + ' ' + sum + ' ' + ts + "\n";
      }

      sum = cumulativeValues[count-1];
      mean = sum / count;

      var sumOfDiffs = 0;
      for (var i = 0; i < count; i++) {
         sumOfDiffs += (values[i] - mean) * (values[i] - mean);
      }
      var stddev = Math.sqrt(sumOfDiffs / count);

      message += 'stats.timers.' + key + '.std ' + stddev  + ' ' + ts + "\n";
      message += 'stats.timers.' + key + '.upper ' + max   + ' ' + ts + "\n";
      message += 'stats.timers.' + key + '.lower ' + min   + ' ' + ts + "\n";
      message += 'stats.timers.' + key + '.count ' + count + ' ' + ts + "\n";
      message += 'stats.timers.' + key + '.sum ' + sum  + ' ' + ts + "\n";
      message += 'stats.timers.' + key + '.mean ' + mean + ' ' + ts + "\n";
      statString += message;

      numStats += 1;
    }
  }

  for (key in gauges) {
    //Compute the min, max, mean, stddev
    var values = gauges[key].sort(function(a, b) { return a - b; });
    var realLength = values.length;
    if (values.length === 0) {
      values = [0];
    }

    var total = 0;
    values.map(function(x) { total += x; });

    var mean = total / values.length;
    var sumdiffs = 0; 
    values.map(function(x) {  sumdiffs+= (x - mean) * (x - mean); });

    var variance = sumdiffs / values.length;
    var stddev = Math.sqrt(variance);

    var message = "";
    message += "stats.gauges." + key + ".lower " + values[0] + ' ' + ts + "\n";
    message += "stats.gauges." + key + ".upper " + values[values.length - 1] + ' ' + ts + "\n";
    message += "stats.gauges." + key + ".mean " + mean + ' ' + ts + "\n";
    message += "stats.gauges." + key + ".count " + realLength + ' ' + ts + "\n";
    message += "stats.gauges." + key + ".stddev " + stddev + ' ' + ts + "\n";
    statString += message;

    numStats += 1;
  }

  for (key in sets) {
    statString += 'stats.sets.' + key + '.count ' + sets[key].values().length + ' ' + ts + "\n";
    numStats += 1;
  }

  statString += 'statsd.numStats ' + numStats + ' ' + ts + "\n";
  statString += 'stats.statsd.graphiteStats.calculationtime ' + (Date.now() - starttime) + ' ' + ts + "\n";
  post_stats(statString);
};

var backend_status = function graphite_status(writeCb) {
  for (stat in graphiteStats) {
    writeCb(null, 'graphite', stat, graphiteStats[stat]);
  }
};

exports.init = function graphite_init(startup_time, config, events) {
  debug = config.debug;
  graphiteHost = config.graphiteHost;
  graphitePort = config.graphitePort;

  graphiteStats.last_flush = startup_time;
  graphiteStats.last_exception = startup_time;

  flushInterval = config.flushInterval;

  events.on('flush', flush_stats);
  events.on('status', backend_status);

  return true;
};
