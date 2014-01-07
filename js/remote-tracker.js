var Class = require('jsclass/src/core').Class,
    Tracker = require("./tracker"),
    eventbus = require('./event-bus'),
    _ = require('lodash'),
    fs = require("fs-extra"),
    restify = require('restify'),
    log = require('kadoh/lib/logging').ns('RemoteTracker'),
    path = require("path"),
    http = require("http"),
    unzip = require("unzip"),
    Crypto = require("crypto"),
    fstream = require("fstream");

var RemoteTracker = module.exports = new Class(Tracker, {

  events: {
    trackerOnline:   "trackerOnline",
    trackerOffline: "trackerOffline"
  },

  initialize: function(nodeId, trackerId, remoteNodeInfo, callback) {
    var that = this;
    this.nodeId = nodeId;
    this.remoteNodeInfo = remoteNodeInfo;
    this._trackerJSON;
    this.id = trackerId;
    this.remote = true;
    this.verified = false;
    this.trackerLocation = GLOBAL.dataPath+ "/cache/node/"+nodeId+"/tracker/" + trackerId + "/tracker.json";

    if (fs.existsSync(this.trackerLocation)){
      this._trackerJSON = JSON.parse(fs.readFileSync(this.trackerLocation));

      if (callback !== undefined){
        callback(null, that);
      }
    } else {
      if (remoteNodeInfo === undefined){
        return callback("Unable to initialize Remote Tracker as no cache exists, and remoteNodeInfo is undefined. ID = " + trackerId);
      }
      var protocol = remoteNodeInfo.restProtocol||'http';
      var client = restify.createJsonClient({url: protocol+'://' + remoteNodeInfo.restAddress});

      var cb = function(tracker){
        if (callback !== undefined){
          callback(null, tracker);
        }
        client.close();
      }

      client.get('/tracker/'+trackerId, function(err, req, res, remoteTrackerJSON) {
        if (err) throw err;

        // TODO - check if node is verified by user

        if (remoteNodeInfo.publicKey == undefined){
          log.warn("Unable to verify tracker as remote node has no public key.");
          that.verified = false;
        } else if (remoteTrackerJSON.signature == undefined){
          log.warn("Unable to verify tracker as no signature was found.");
          that.verified = false;
        } else {
          var verifier = Crypto.createVerify('RSA-SHA256');

          //clone
          var payload = JSON.parse(JSON.stringify(remoteTrackerJSON));
          delete payload.signature
          var signature = remoteTrackerJSON.signature
          verifier.update(JSON.stringify(payload));
          var publicKey = remoteNodeInfo.publicKey;

          that.verified = verifier.verify(publicKey, signature, 'hex');
        }

        if (!that.verified){
          log.warn("Remote tracker is not verified!");
        }

        that._trackerJSON = remoteTrackerJSON;
        cb(that);
      });
    };

   process.nextTick(function() { eventbus.emit( eventbus.events.tracker.initialized, that); });
  },

  setRemoteNodeInfo: function(remoteNodeInfo){
    this.remoteNodeInfo = remoteNodeInfo;
  },

  getThing: function(thingId, version, callback){
    var that = this;
    version = version || this.getThingLatestVersion(thingId);
    var thingURL = '/tracker/'+this.id+'/thing/'+thingId+'/version/'+version;

    var cachedThingLocation = GLOBAL.dataPath + "/cache/node/"+this.nodeId+thingURL + "/thing.json";

    if (fs.existsSync(cachedThingLocation)){
      var thingJSON = JSON.parse(fs.readFileSync(cachedThingLocation));
      if (callback !== undefined){
          callback(null, thingJSON);
        }
    } else {
      if (this.remoteNodeInfo === undefined){
        return log.warn("Unable to get Thing as remoteNodeInfo is undefined. ID = " + thingId);
      }
      var protocol = this.remoteNodeInfo.restProtocol || 'http';
      var client = restify.createJsonClient({url: protocol+'://' + this.remoteNodeInfo.restAddress});

      var cb = function(thingJSON){
        if (callback !== undefined){
          callback(null, thingJSON);
        }
        client.close();
      };

      client.get(thingURL, function(err, req, res, thingJSON) {
        if (err) {return callback(err);}

        fs.outputJson(cachedThingLocation, thingJSON, function(err){
          if (err) {return log.warn("Error caching remote thing, ", err);}
        });

        cb(thingJSON);
      });
    }
  },

  createThing: function(newThing, files, thumbnailPaths){
    throw new Error("Cannot create thing in remote tracker.");
  },

  getDownloadPath: function(thing){
    if (!thing){
      log.error("Attempt to get download path with an undefined thing reference.");
      return undefined;
    }
    return fs.realpathSync(GLOBAL.dataPath)+"/cache/node/"+this.nodeId+ "/tracker/"+this.id+"/thing/"+thing.id+"/version/"+thing.version+"/content/";
  },

  downloadThing: function(thing, callback){
    if (thing === undefined){
      log.error("Attempt to download content with an undefined thing reference.");
      return;
    }

    if (thing.downloadURL === undefined){
      log.error("Attempt to download content with an undefined thing downloadURL.");
      return;
    }

    if (GLOBAL.dataPath === undefined){
      return log.error("No data path set!");
    }

    if (this.remoteNodeinfo === undefined){
     return log.error("Tracker has no remoteNodeinfo.");
    }

    //TODO - fix to use rest server + protocol
    var url = 'http://' + remoteNodeinfo.restAddress+thing.downloadURL;

    console.log("url = ",url);

    var filename=path.basename(url);
    var filenameExt = path.extname(filename);

    if (filenameExt != ".zip"){
      log.error("Only zip file downloadable content is handled at the moment. downloadURL points to a file with extension: " + filenameExt);
      return;
    }

    var cacheZipLocation = fs.realpathSync(GLOBAL.dataPath) +"/cache/node/"+this.nodeId * "tracker/"+this.id+"/thing/"+thing.id + "/version/" + thing.version;
    var cacheContentLocation = cacheZipLocation + "/content/";

    if (!fs.existsSync(cacheContentLocation)){
      fs.mkdirsSync(cacheContentLocation);
    }

    var file = fs.createWriteStream(cacheZipLocation+"/" + filename);

    var outputDirStream = fstream.Writer(cacheContentLocation);

    var request = http.get(url, function(response) {

      if (response.statusCode == 200){
        // Unpack the zip locally (commented out as it might be dangerous)
        //response.pipe(unzip.Parse()).pipe(outputDirStream);

        // Save the zip file.
        response.pipe(file)

        file.on('finish', function() {
          file.close();
          if (callback){
            callback(cacheZipLocation);
          }
        });
      } else {
        log.warn("Error retrieving zip file. status code: ", response.statusCode);
        file.close();
      }

    });
  }

});