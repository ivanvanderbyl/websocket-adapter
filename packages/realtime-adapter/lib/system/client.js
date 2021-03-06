var now = function() {
  if (Date.now) {
    return Date.now();
  } else {
    return new Date().valueOf;
  }
};

import Frame from './frame';

var Byte = Frame.Byte;

var Client = Ember.Object.extend(Ember.Evented, {

  connected: false,

  maxWebSocketFrameSize: 16 * 1024,

  /**
   * The WebSocket connection
   * @type WebSocket
   */
  socket: null,

  /**
   * Init
   */
  init: function(){
    this.subscriptions = {};
    this._subscriptionList = {};
    this.counter = 0;
  },

  /**
   * Expected incoming heartbeat from server
   *
   * @type {Number}
   */
  incomingHeartbeat: 8E3,

  /**
   * Desired outgoing heartbeat from client
   *
   * @type {Number}
   */
  outgoingHeartbeat: 1E3,

  socketDidChange: function() {
    var ws = this.get('socket');

    ws.onmessage = this.didReceiveMessage.bind(this);
    ws.onopen = Ember.run.bind(this, this.willConnect);
    ws.onclose = Ember.run.bind(this, this.socketDidClose);

    if (ws.readyState === WebSocket.OPEN) {
      this.willConnect();
    }
  }.observes('socket').on('init'),

  errorHandler: Ember.K,

  errorHandlerDidChange: function() {
    var handler = this.get('errorHandler');
    var socket = this.get('socket');

    if (socket && handler) {
      socket.onerror = handler;
    }
  }.observes('errorHandler', 'socket'),

  /**
   * Callback which fires before the STOMP session is negotiated.
   *
   * @param  {Object} headers
   *
   * @expose
   * @public
   */
  willConnect: function() {
    Ember.debug('WebSocket connected');
    var headers = {};
    headers["accept-version"] = Client.STOMP_VERSIONS.supportedVersions();
    this._transmit("CONNECT", headers);
  },

  /**
   * Callback which fires when STOMP session is connected.
   *
   * @type {Function}
   */
  didConnect: Ember.K,

  disconnect: function(){
    this.get('socket').close();
  },

  socketDidClose: function(reason){
    this._cleanUp();
    Ember.debug('WebSocket connection closed');
  },

  /**
   * Callback which is called when the underlying WebSocket receives a message.
   *
   * @param  {String} bytes
   *
   * @expose
   * @public
   */
  didReceiveMessage: function(event) {
    this._serverActivity = now();

    var bytes = event.data;

    if (bytes === Byte.LF) {
      Ember.debug("<<< PONG");
      return;
    }

    // console.log(bytes)

    var frame = Frame.create();
    frame.unmarshal(bytes);

    switch (frame.command) {
      case "CONNECTED":
        Ember.debug('Connected to server');
        // this._setupHeartbeat(frame.headers);
        this.set('connected', true);
        this.didConnect();
      break;
      case "MESSAGE":
        var subscriptionId = frame.headers['subscription'];
        console.log(subscriptionId, this.subscriptions)
        var subscriptionCallback = this.subscriptions[subscriptionId];

        if (subscriptionCallback) {
          var messageID = frame.headers["message-id"];
          var client = this;

          frame.ack = function(headers) {
            return client.ack(messageID, subscriptionId, headers);
          };
          frame.nack = function(headers) {
            return client.nack(messageID, subscriptionId, headers);
          };

          subscriptionCallback(frame);
          // Ember.run.bind(this, subscriptionCallback, frame);
        }else{
          Ember.Logger.error('Unhandled MESSAGE received: ' + bytes);
        }

      break;
    }
  },

  /**
   * Encodes and Sends a message as a STOMP SEND frame
   *
   * @param  {String} destination
   * @param  {Object} headers
   * @param  {String} body
   *
   * @expose
   * @public
   */
  send: function(destination, headers, body) {
    if (!headers) { headers = {}; }
    if (!body) { body = ''; }

    headers['destination'] = destination;
    return this._transmit("SEND", headers, body);
  },

  /**
   * Request sends a request for the given resource and returns the first
   * correlated message for that resource in a callback.
   *
   * Client                     Server
   * ---------------------------------
   * SUBSCRIBE posts ---------> [tx-1]
   * SEND [{}] --- CREATE ----> [1]
   * [tx-1] <----- CREATED ---- MESSAGE
   * UNSUBSCRIBE posts -------> tx-1
   *
   *
   * @param  {String}   destination Resource path
   * @param  {Object}   headers     Additional Headers
   * @param  {String or Object}   body        Body to encode
   * @param  {Function} callback
   *
   */
  request: function(destination, headers, body, callback){
    this.subscribe(destination, function() {

    })
    this.send(destination, headers, body);
  },

  /**
   * Creates a subscription for the given path
   *
   * @param  {String}   destination Resource to subscribe to
   * @param  {Object}   headers     Additional Headers to include in subscription
   * @param  {Function} callback    Callback to fire when a message in received
   *
   * @return {String}               Subscription ID
   */
  subscribe: function(destination, headers, callback){
    if (!headers) { headers = {}; }
    if (!headers.id) { headers.id = "sub-" + this.counter++; }
    headers.destination = destination;
    this.subscriptions[headers.id] = callback;
    this._transmit("SUBSCRIBE", headers);

    this._subscriptionList[destination] = headers.id;

    return headers.id;
  },

  subscribeOnce: function(destination, headers, callback){
    if (this._subscriptionList[destination]) { return };
    this.subscribe(destination, headers, callback);
  },

  unsubscribe: function(subscriptionId, headers){
    if (!headers) { headers = {}; }
    if (!headers.id) { headers.id = subscriptionId }
    delete this.subscriptions[subscriptionId];

    Object.keys(this._subscriptionList).forEach(function(key) {
      if (this._subscriptionList[key] === subscriptionId) {
        delete this._subscriptionList[key];
      }
    })

    this._transmit("UNSUBSCRIBE", headers);
  },

  /**
   * Sends an ACK frame
   *
   * @param  {String} messageID
   * @param  {String} subscriptionId
   * @param  {Object} headers
   *
   */
  ack: function(messageID, subscriptionId, headers){
    if (!headers) { headers = {}; }
    headers['message-id'] = messageID;
    headers['subscription'] = subscriptionId;
    return this._transmit("ACK", headers);
  },

  /**
   * Sends an NACK frame
   *
   * @param  {String} messageID
   * @param  {String} subscriptionId
   * @param  {Object} headers
   *
   */
  nack: function(messageID, subscriptionId, headers){
    if (!headers) { headers = {}; }
    headers['message-id'] = messageID;
    headers['subscription'] = subscriptionId;
    return this._transmit("NACK", headers);
  },

  /**
   * Start a transaction
   *
   * @return {Object} Transaction
   */
  begin: function(){
    var transactionId = "tx-" + this.counter++;
    this._transmit("BEGIN", {
      transaction: transactionId
    });
    var client = this;

    return {
      id: transactionId,
      commit: function() {
        return client.commit(transactionId);
      },
      abort: function() {
        return client.abort(transactionId);
      }
    };
  },

  /**
   * Abort an existing transaction
   *
   * @param  {String} transactionId
   */
  abort: function(transactionId){
    var headers = {};
    headers['transaction'] = transactionId;
    return this._transmit("ABORT", headers);
  },

  /**
   * Commit an existing transaction
   *
   * @param  {String} transactionId
   */
  commit: function(transactionId){
    var headers = {};
    headers['transaction'] = transactionId;
    return this._transmit("COMMIT", headers);
  },

  _transmit: function(command, headers, body){
    var out;
    out = Frame.createWithCommand(command, headers, body).marshal();

    Ember.debug("Client: >>> " + out.substring(0, 256) + '...');

    var socket = this.get('socket');

    while (true) {
      if (out.length > this.maxWebSocketFrameSize) {
        socket.send(out.substring(0, this.maxWebSocketFrameSize));
        out = out.substring(this.maxWebSocketFrameSize);
        Ember.debug("Client: remaining = " + out.length);
      } else {
        return socket.send(out);
      }
    }
  },

  _setupHeartbeat: function(headers){
    var version = headers.version;
    if (version !== Client.STOMP_VERSIONS.V1_1 && version !== Client.STOMP_VERSIONS.V1_2) {
      return;
    }

    var heartbeats = headers['heart-beat'].split(",").map(function(ttl) {
      return parseInt(ttl);
    });

    console.log("Server configured heart beat:", heartbeats)

    // var serverOutgoing = heartbeats[0];
    // var serverIncoming = heartbeats[1];

    // if (!(this.get('outgoingHeartbeat') === 0 || serverIncoming === 0)) {
    //   var ttl = Math.max(this.get('outgoingHeartbeat'), serverIncoming);
    //   Ember.debug("send PING every " + ttl + "ms");

    //   this.pinger = setInterval(function() {
    //     if (this.get('socket.readyState') === WebSocket.OPEN) {
    //       Ember.debug('>>> PING');
    //       this.get('socket').send(Byte.LF);
    //     }
    //   }.bind(this), ttl);
    // }

    // if (!(this.get('incomingHeartbeat') === 0 || serverOutgoing === 0)) {
    //   var ttl = Math.max(this.get('incomingHeartbeat'), serverOutgoing);
    //   Ember.debug("check PONG every " + ttl + "ms");
    //   this.ponger = setInterval(function() {
    //     var delta;
    //     delta = now() - this._serverActivity;
    //     if (delta > ttl * 2) {
    //       Ember.debug("did not receive server activity for the last " + delta + "ms");
    //       // this.get('socket').close();
    //     }
    //   }.bind(this), ttl);
    // }
  },

  _cleanUp: function() {
    this.set('connected', false);
    if (this.pinger) { clearInterval(this.pinger); }
    if (this.ponger) { clearInterval(this.ponger); }
  },

  willDestroy: function(){
    Ember.debug('Destroying client')
    this._cleanUp();
  },
});

Client.reopenClass({

  /**
   * STOMP Versions
   *
   * @type {Object}
   */
  STOMP_VERSIONS: {
    V1_0: '1.0',
    V1_1: '1.1',
    V1_2: '1.2',

    /**
     * Returns suported protocol versions
     *
     * @return {String}
     */
    supportedVersions: function() {
      return '1.1,1.0';
    }
  },

  /**
   * Creates a Client with an active WebSocket connection
   *
   * @param  {WebSocket} ws
   *
   * @return {Realtime.Client}
   * @expose
   * @public
   */
  createWithWebSocket: function(ws){
    return Client.create({ socket: ws });
  },

  /**
   * Creates a Client and opens a new WebSocket connection
   *
   * @param  {String} url A fully qualified WebSocket connection.
   *
   * @return {Realtime.Client}
   * @expose
   * @public
   */
  createWithAddress: function(url){
    var ws = new WebSocket(url, 'STOMP');
    return this.createWithWebSocket(ws);
  },
})

export default Client;
