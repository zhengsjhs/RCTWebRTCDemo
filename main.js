'use strict';

import React, { Component } from 'react';
import {
  AppRegistry,
  StyleSheet,
  Text,
  TouchableHighlight,
  View,
  TextInput,
  ListView,
  Platform,
} from 'react-native';

import io from 'socket.io-client';

//const socket = io.connect('https://react-native-webrtc.herokuapp.com', {transports: ['websocket']});
//const socket = io.connect('wss://react-native-webrtc.herokuapp.com');

import {
  RTCPeerConnection,
  RTCMediaStream,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  MediaStreamTrack,
  getUserMedia,
} from 'react-native-webrtc';

const configuration = {"iceServers": [{"url": "turn:120.55.192.228:3478?transport=udp"},{"url": "turn:120.55.192.228:3478?transport=tcp"},{"url": "turn:120.55.192.228:3479?transport=udp"},{"url": "turn:120.55.192.228:3479?transport=tcp"}]};

const pcPeers = {};
let localStream;
// Create our JsSIP instance and run it:
import SIP from 'sip.js';


var env = {};
env.getUserMedia = getUserMedia;
SIP.WebRTC.MediaStream = RTCMediaStream;
SIP.WebRTC.getUserMedia = SIP.Utils.promisify(env, 'getUserMedia');
SIP.WebRTC.RTCPeerConnection = RTCPeerConnection;
SIP.WebRTC.RTCSessionDescription = RTCSessionDescription;
    
    var MediaHandler = function(session, options) {
        options = options || {};
        
        this.logger = session.ua.getLogger('sip.invitecontext.mediahandler', session.id);
        this.session = session;
        this.localMedia = localStream;
        this.ready = true;
        this.mediaStreamManager = options.mediaStreamManager || new SIP.WebRTC.MediaStreamManager(this.logger);
        this.audioMuted = false;
        this.videoMuted = false;
        this.local_hold = false;
        this.remote_hold = false;
        this.candidates = new Array;
        // old init() from here on
        var servers = this.prepareIceServers(options.stunServers, options.turnServers);
        this.RTCConstraints = options.RTCConstraints || {};
        
        this.initPeerConnection(servers);
        
        function selfEmit(mh, event) {
            if (mh.mediaStreamManager.on) {
                mh.mediaStreamManager.on(event, function () {
                                         mh.emit.apply(mh, [event].concat(Array.prototype.slice.call(arguments)));
                                         });
            }
        }
        
        selfEmit(this, 'userMediaRequest');
        selfEmit(this, 'userMedia');
        selfEmit(this, 'userMediaFailed');
    };
    
    MediaHandler.defaultFactory = function defaultFactory (session, options) {
        return new MediaHandler(session, options);
    };
    MediaHandler.defaultFactory.isSupported = function () {
        return true;
    };
    
    MediaHandler.prototype = Object.create(SIP.MediaHandler.prototype, {
                                           // Functions the session can use
                                           isReady: {writable: true, value: function isReady () {
                                           return this.ready;
                                           }},
                                           
                                           close: {writable: true, value: function close () {
                                           this.logger.log('closing PeerConnection');
                                           this._remoteStreams = [];
                                           // have to check signalingState since this.close() gets called multiple times
                                           // TODO figure out why that happens
                                           if(this.peerConnection && this.peerConnection.signalingState !== 'closed') {
                                           this.peerConnection.close();
                                           
                                           if(this.localMedia) {
                                           this.mediaStreamManager.release(this.localMedia);
                                           }
                                           }
                                           }},
                                           
                                           /**
                                            * @param {SIP.WebRTC.MediaStream | (getUserMedia constraints)} [mediaHint]
                                            *        the MediaStream (or the constraints describing it) to be used for the session
                                            */
                                           getDescription: {writable: true, value: function getDescription (mediaHint) {
                                           var self = this;
                                           var acquire = self.mediaStreamManager.acquire;
                                           if (acquire.length > 1) {
                                           acquire = SIP.Utils.promisify(this.mediaStreamManager, 'acquire', true);
                                           }
                                           mediaHint = mediaHint || {};
                                           if (mediaHint.dataChannel === true) {
                                           mediaHint.dataChannel = {};
                                           }
                                           this.mediaHint = mediaHint;
                                           
                                           /*
                                            * 1. acquire streams (skip if MediaStreams passed in)
                                            * 2. addStreams
                                            * 3. createOffer/createAnswer
                                            */
                                           
                                           var streamPromise;
                                           //self.localMedia = localStream;
                                           if (self.localMedia) {
                                           self.logger.log('already have local media');
                                           streamPromise = SIP.Utils.Promise.resolve(self.localMedia);
                                           }
                                           else {
                                           self.logger.log('acquiring local media');
                                           
                                           streamPromise = acquire.call(self.mediaStreamManager, mediaHint)
                                           .then(function acquireSucceeded(streams) {
                                                 self.logger.log('acquired local media streams');
                                                 self.localMedia = streams;
                                                 self.session.connecting();
                                                 return streams;
                                                 }, function acquireFailed(err) {
                                                 self.logger.error('unable to acquire streams');
                                                 self.logger.error(err);
                                                 self.session.connecting();
                                                 throw err;
                                                 })
                                           .then(this.addStreams.bind(this))
                                           ;
                                           }
                                           
                                           return streamPromise
                                           .then(function streamAdditionSucceeded() {
                                                 if (self.hasOffer('remote')) {
                                                 self.peerConnection.ondatachannel = function (evt) {
                                                 self.dataChannel = evt.channel;
                                                 self.emit('dataChannel', self.dataChannel);
                                                 };
                                                 } else if (mediaHint.dataChannel &&
                                                            self.peerConnection.createDataChannel) {
                                                 self.dataChannel = self.peerConnection.createDataChannel(
                                                                                                          'sipjs',
                                                                                                          mediaHint.dataChannel
                                                                                                          );
                                                 self.emit('dataChannel', self.dataChannel);
                                                 }
                                                 
                                                 self.render();
                                                 return self.createOfferOrAnswer(self.RTCConstraints);
                                                 })
                                           .then(function(sdp) {
                                                 sdp = SIP.Hacks.Firefox.hasMissingCLineInSDP(sdp);
                                                 
                                                 if (self.local_hold) {
                                                 // Don't receive media
                                                 // TODO - This will break for media streams with different directions.
                                                 if (!(/a=(sendrecv|sendonly|recvonly|inactive)/).test(sdp)) {
                                                 sdp = sdp.replace(/(m=[^\r]*\r\n)/g, '$1a=sendonly\r\n');
                                                 } else {
                                                 sdp = sdp.replace(/a=sendrecv\r\n/g, 'a=sendonly\r\n');
                                                 sdp = sdp.replace(/a=recvonly\r\n/g, 'a=inactive\r\n');
                                                 }
                                                 }
                                                 
                                                 return {
                                                 body: sdp,
                                                 contentType: 'application/sdp'
                                                 };
                                                 })
                                           ;
                                           }},
                                           
                                           /**
                                            * Check if a SIP message contains a session description.
                                            * @param {SIP.SIPMessage} message
                                            * @returns {boolean}
                                            */
                                           hasDescription: {writeable: true, value: function hasDescription (message) {
                                           return message.getHeader('Content-Type') === 'application/sdp' && !!message.body;
                                           }},
                                           
                                           /**
                                            * Set the session description contained in a SIP message.
                                            * @param {SIP.SIPMessage} message
                                            * @returns {Promise}
                                            */
                                           setDescription: {writable: true, value: function setDescription (message) {
                                           var self = this;
                                           var sdp = message.body;
                                           
                                           this.remote_hold = /a=(sendonly|inactive)/.test(sdp);
                                           
                                           sdp = SIP.Hacks.Firefox.cannotHandleExtraWhitespace(sdp);
                                           sdp = SIP.Hacks.AllBrowsers.maskDtls(sdp);
                                           
                                           var rawDescription = {
                                           type: this.hasOffer('local') ? 'answer' : 'offer',
                                           sdp: sdp
                                           };
                                           
                                           this.emit('setDescription', rawDescription);
                                           
                                           var description = new SIP.WebRTC.RTCSessionDescription(rawDescription);
                                           return SIP.Utils.promisify(this.peerConnection, 'setRemoteDescription')(description)
                                           .catch(function setRemoteDescriptionError(e) {
                                                  self.emit('peerConnection-setRemoteDescriptionFailed', e);
                                                  throw e;
                                                  });
                                           }},
                                           
                                           /**
                                            * If the Session associated with this MediaHandler were to be referred,
                                            * what mediaHint should be provided to the UA's invite method?
                                            */
                                           getReferMedia: {writable: true, value: function getReferMedia () {
                                           function hasTracks (trackGetter, stream) {
                                           return stream[trackGetter]().length > 0;
                                           }
                                           
                                           function bothHaveTracks (trackGetter) {
                                           /* jshint validthis:true */
                                           return this.getLocalStreams().some(hasTracks.bind(null, trackGetter)) &&
                                           this.getRemoteStreams().some(hasTracks.bind(null, trackGetter));
                                           }
                                           
                                           return {
                                           constraints: {
                                           audio: bothHaveTracks.call(this, 'getAudioTracks'),
                                           video: bothHaveTracks.call(this, 'getVideoTracks')
                                           }
                                           };
                                           }},
                                           
                                           updateIceServers: {writeable:true, value: function (options) {
                                           var servers = this.prepareIceServers(options.stunServers, options.turnServers);
                                           this.RTCConstraints = options.RTCConstraints || this.RTCConstraints;
                                           
                                           this.initPeerConnection(servers);
                                           
                                           /* once updateIce is implemented correctly, this is better than above
                                            //no op if browser does not support this
                                            if (!this.peerConnection.updateIce) {
                                            return;
                                            }
                                            
                                            this.peerConnection.updateIce({'iceServers': servers}, this.RTCConstraints);
                                            */
                                           }},
                                           
                                           // Functions the session can use, but only because it's convenient for the application
                                           isMuted: {writable: true, value: function isMuted () {
                                           return {
                                           audio: this.audioMuted,
                                           video: this.videoMuted
                                           };
                                           }},
                                           
                                           mute: {writable: true, value: function mute (options) {
                                           if (this.getLocalStreams().length === 0) {
                                           return;
                                           }
                                           
                                           options = options || {
                                           audio: this.getLocalStreams()[0].getAudioTracks().length > 0,
                                           video: this.getLocalStreams()[0].getVideoTracks().length > 0
                                           };
                                           
                                           var audioMuted = false,
                                           videoMuted = false;
                                           
                                           if (options.audio && !this.audioMuted) {
                                           audioMuted = true;
                                           this.audioMuted = true;
                                           this.toggleMuteAudio(true);
                                           }
                                           
                                           if (options.video && !this.videoMuted) {
                                           videoMuted = true;
                                           this.videoMuted = true;
                                           this.toggleMuteVideo(true);
                                           }
                                           
                                           //REVISIT
                                           if (audioMuted || videoMuted) {
                                           return {
                                           audio: audioMuted,
                                           video: videoMuted
                                           };
                                           /*this.session.onmute({
                                            audio: audioMuted,
                                            video: videoMuted
                                            });*/
                                           }
                                           }},
                                           
                                           unmute: {writable: true, value: function unmute (options) {
                                           if (this.getLocalStreams().length === 0) {
                                           return;
                                           }
                                           
                                           options = options || {
                                           audio: this.getLocalStreams()[0].getAudioTracks().length > 0,
                                           video: this.getLocalStreams()[0].getVideoTracks().length > 0
                                           };
                                           
                                           var audioUnMuted = false,
                                           videoUnMuted = false;
                                           
                                           if (options.audio && this.audioMuted) {
                                           audioUnMuted = true;
                                           this.audioMuted = false;
                                           this.toggleMuteAudio(false);
                                           }
                                           
                                           if (options.video && this.videoMuted) {
                                           videoUnMuted = true;
                                           this.videoMuted = false;
                                           this.toggleMuteVideo(false);
                                           }
                                           
                                           //REVISIT
                                           if (audioUnMuted || videoUnMuted) {
                                           return {
                                           audio: audioUnMuted,
                                           video: videoUnMuted
                                           };
                                           /*this.session.onunmute({
                                            audio: audioUnMuted,
                                            video: videoUnMuted
                                            });*/
                                           }
                                           }},
                                           
                                           hold: {writable: true, value: function hold () {
                                           this.local_hold = true;
                                           this.toggleMuteAudio(true);
                                           this.toggleMuteVideo(true);
                                           }},
                                           
                                           unhold: {writable: true, value: function unhold () {
                                           this.local_hold = false;
                                           
                                           if (!this.audioMuted) {
                                           this.toggleMuteAudio(false);
                                           }
                                           
                                           if (!this.videoMuted) {
                                           this.toggleMuteVideo(false);
                                           }
                                           }},
                                           
                                           // Functions the application can use, but not the session
                                           getLocalStreams: {writable: true, value: function getLocalStreams () {
                                           var pc = this.peerConnection;
                                           if (pc && pc.signalingState === 'closed') {
                                           this.logger.warn('peerConnection is closed, getLocalStreams returning []');
                                           return [];
                                           }
                                           return (pc.getLocalStreams && pc.getLocalStreams()) ||
                                           pc.localStreams || [];
                                           }},
                                           
                                           getRemoteStreams: {writable: true, value: function getRemoteStreams () {
                                           var pc = this.peerConnection;
                                           if (pc && pc.signalingState === 'closed') {
                                           this.logger.warn('peerConnection is closed, getRemoteStreams returning this._remoteStreams');
                                           return this._remoteStreams;
                                           }
                                           return(pc.getRemoteStreams && pc.getRemoteStreams()) ||
                                           pc.remoteStreams || [];
                                           }},
                                           
                                           render: {writable: true, value: function render (renderHint) {
                                           renderHint = renderHint || (this.mediaHint && this.mediaHint.render);
                                           if (!renderHint) {
                                           return false;
                                           }
                                           var streamGetters = {
                                           local: 'getLocalStreams',
                                           remote: 'getRemoteStreams'
                                           };
                                           Object.keys(streamGetters).forEach(function (loc) {
                                                                              var streamGetter = streamGetters[loc];
                                                                              var streams = this[streamGetter]();
                                                                              SIP.WebRTC.MediaStreamManager.render(streams, renderHint[loc]);
                                                                              }.bind(this));
                                           }},
                                           
                                           // Internal functions
                                           hasOffer: {writable: true, value: function hasOffer (where) {
                                           var offerState = 'have-' + where + '-offer';
                                           return this.peerConnection.signalingState === offerState;
                                           // TODO consider signalingStates with 'pranswer'?
                                           }},
                                           
                                           prepareIceServers: {writable: true, value: function prepareIceServers (stunServers, turnServers) {
                                           var servers = [],
                                           config = this.session.ua.configuration;
                                           
                                           stunServers = stunServers || config.stunServers;
                                           turnServers = turnServers || config.turnServers;
                                           
                                           [].concat(stunServers).forEach(function (server) {
                                                                          servers.push({'urls': server});
                                                                          });
                                           
                                           [].concat(turnServers).forEach(function (server) {
                                                                          var turnServer = {'urls': server.urls};
                                                                          if (server.username) {
                                                                          turnServer.username = server.username;
                                                                          }
                                                                          if (server.password) {
                                                                          turnServer.credential = server.password;
                                                                          }
                                                                          servers.push(turnServer);
                                                                          });
                                           
                                           return servers;
                                           }},
                                           
                                           initPeerConnection: {writable: true, value: function initPeerConnection(servers) {
                                           var self = this,
                                           config = this.session.ua.configuration;
                                           
                                           this.onIceCompleted = SIP.Utils.defer();
                                           this.onIceCompleted.promise.then(function(pc) {
                                                                            self.emit('iceGatheringComplete', pc);
                                                                            if (self.iceCheckingTimer) {
                                                                            SIP.Timers.clearTimeout(self.iceCheckingTimer);
                                                                            self.iceCheckingTimer = null;
                                                                            }
                                                                            });
                                           
                                           if (this.peerConnection) {
                                           this.peerConnection.close();
                                           }
                                           
                                           var connConfig = {
                                           iceServers: servers
                                           };
                                           
                                           if (config.rtcpMuxPolicy) {
                                           connConfig.rtcpMuxPolicy = config.rtcpMuxPolicy;
                                           }
                                           
                                           this.peerConnection = new RTCPeerConnection(connConfig);
                                           
                                           // Firefox (35.0.1) sometimes throws on calls to peerConnection.getRemoteStreams
                                           // even if peerConnection.onaddstream was just called. In order to make
                                           // MediaHandler.prototype.getRemoteStreams work, keep track of them manually
                                           this._remoteStreams = [];
                                           
                                           this.peerConnection.onaddstream = function(e) {
                                           self.logger.log('stream added: '+ e.stream.id);
                                           self._remoteStreams.push(e.stream);
                                           self.render();
                                           self.emit('addStream', e);
                                           };
                                           
                                           this.peerConnection.onremovestream = function(e) {
                                           self.logger.log('stream removed: '+ e.stream.id);
                                           };
                                           
                                           this.startIceCheckingTimer = function () {
                                           if (!self.iceCheckingTimer) {
                                           self.iceCheckingTimer = SIP.Timers.setTimeout(function() {
                                                                                         self.logger.log('RTCIceChecking Timeout Triggered after '+config.iceCheckingTimeout+' milliseconds');
                                                                                         self.onIceCompleted.resolve(this);
                                                                                         }.bind(this.peerConnection), config.iceCheckingTimeout);
                                           }
                                           };
                                           
                                           this.peerConnection.onicecandidate = function(e) {
                                           self.emit('iceCandidate', e);
                                           if (e.candidate) {
                                           self.candidates.push(e.candidate.candidate);
                                           self.logger.log('ICE candidate received: '+ (e.candidate.candidate === null ? null : e.candidate.candidate.trim()));
                                           self.startIceCheckingTimer();
                                           } else {
                                           self.onIceCompleted.resolve(this);
                                           }
                                           };
                                           
                                           this.peerConnection.onicegatheringstatechange = function () {
                                           self.logger.log('RTCIceGatheringState changed: ' + this.iceGatheringState);
                                           if (this.iceGatheringState === 'gathering') {
                                           self.emit('iceGathering', this);
                                           }
                                           if (this.iceGatheringState === 'complete') {
                                           self.onIceCompleted.resolve(this);
                                           }
                                           };
                                           
                                           this.peerConnection.oniceconnectionstatechange = function() {  //need e for commented out case
                                           var stateEvent;
                                           
                                           if (this.iceConnectionState === 'checking') {
                                           self.startIceCheckingTimer();
                                           }
                                           
                                           switch (this.iceConnectionState) {
                                           case 'new':
                                           stateEvent = 'iceConnection';
                                           break;
                                           case 'checking':
                                           stateEvent = 'iceConnectionChecking';
                                           break;
                                           case 'connected':
                                           stateEvent = 'iceConnectionConnected';
                                           break;
                                           case 'completed':
                                           stateEvent = 'iceConnectionCompleted';
                                           break;
                                           case 'failed':
                                           stateEvent = 'iceConnectionFailed';
                                           break;
                                           case 'disconnected':
                                           stateEvent = 'iceConnectionDisconnected';
                                           break;
                                           case 'closed':
                                           stateEvent = 'iceConnectionClosed';
                                           break;
                                           default:
                                           self.logger.warn('Unknown iceConnection state:', this.iceConnectionState);
                                           return;
                                           }
                                           self.emit(stateEvent, this);
                                           
                                           //Bria state changes are always connected -> disconnected -> connected on accept, so session gets terminated
                                           //normal calls switch from failed to connected in some cases, so checking for failed and terminated
                                           /*if (this.iceConnectionState === 'failed') {
                                            self.session.terminate({
                                            cause: SIP.C.causes.RTP_TIMEOUT,
                                            status_code: 200,
                                            reason_phrase: SIP.C.causes.RTP_TIMEOUT
                                            });
                                            } else if (e.currentTarget.iceGatheringState === 'complete' && this.iceConnectionState !== 'closed') {
                                            self.onIceCompleted(this);
                                            }*/
                                           };
                                           
                                           this.peerConnection.onstatechange = function() {
                                           self.logger.log('PeerConnection state changed to "'+ this.readyState +'"');
                                           };
                                           }},
                                           
                                           createOfferOrAnswer: {writable: true, value: function createOfferOrAnswer (constraints) {
                                           var self = this;
                                           var methodName;
                                           var pc = self.peerConnection;
                                           
                                           self.ready = false;
                                           methodName = self.hasOffer('remote') ? 'createAnswer' : 'createOffer';
                                           
                                           return SIP.Utils.promisify(pc, methodName, true)(constraints)
                                           .catch(function methodError(e) {
                                                  self.emit('peerConnection-' + methodName + 'Failed', e);
                                                  throw e;
                                                  })
                                           .then(SIP.Utils.promisify(pc, 'setLocalDescription'))
                                           .catch(function localDescError(e) {
                                                  self.emit('peerConnection-selLocalDescriptionFailed', e);
                                                  throw e;
                                                  })
                                           .then(function onSetLocalDescriptionSuccess() {
                                                 var deferred = SIP.Utils.defer();
                                                 if (pc.iceGatheringState === 'complete' && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
                                                 deferred.resolve();
                                                 } else {
                                                 self.onIceCompleted.promise.then(deferred.resolve);
                                                 }
                                                 return deferred.promise;
                                                 })
                                           .then(function readySuccess () {
                                                 var sdp = pc.localDescription.sdp;
                                                 /*var candidate = self.candidates[0].trim();
                                                 var candarr = candidate.split(" ");
                                                 var host = candarr[4];
                                                 var port = candarr[5];
                                                 sdp = sdp.replace(/0.0.0.0/g,host);
                                                 sdp = sdp.replace("m=audio 9 ","m=audio "+port+" ");
                                                 sdp = sdp.replace("a=rtcp:9 ","a=rtcp:"+port+" ");*/
                                                 //sdp=sdp.replace(/^a=ice.*?\r\n/img,"");
                                                 //sdp+='a='+candidate+'\r\n';
                                                 for(var index in self.candidates) {
                                                    sdp+='a='+self.candidates[index].trim()+'\r\n';
                                                 }
                                                 sdp = SIP.Hacks.Chrome.needsExplicitlyInactiveSDP(sdp);
                                                 sdp = SIP.Hacks.AllBrowsers.unmaskDtls(sdp);
                                                 
                                                 var sdpWrapper = {
                                                 type: methodName === 'createOffer' ? 'offer' : 'answer',
                                                 sdp: sdp
                                                 };
                                                 
                                                 self.emit('getDescription', sdpWrapper);
                                                 
                                                 if (self.session.ua.configuration.hackStripTcp) {
                                                 sdpWrapper.sdp = sdpWrapper.sdp.replace(/^a=candidate:\d+ \d+ tcp .*?\r\n/img, "");
                                                 }
                                                 
                                                 self.ready = true;
                                                 return sdpWrapper.sdp;
                                                 })
                                           .catch(function createOfferAnswerError (e) {
                                                  self.logger.error(e);
                                                  self.ready = true;
                                                  throw new SIP.Exceptions.GetDescriptionError(e);
                                                  })
                                           ;
                                           }},
                                           
                                           addStreams: {writable: true, value: function addStreams (streams) {
                                           try {
                                           streams = [].concat(streams);
                                           streams.forEach(function (stream) {
                                                           this.peerConnection.addStream(stream);
                                                           }, this);
                                           } catch(e) {
                                           this.logger.error('error adding stream');
                                           this.logger.error(e);
                                           return SIP.Utils.Promise.reject(e);
                                           }
                                           
                                           return SIP.Utils.Promise.resolve();
                                           }},
                                           
                                           toggleMuteHelper: {writable: true, value: function toggleMuteHelper (trackGetter, mute) {
                                           this.getLocalStreams().forEach(function (stream) {
                                                                          stream[trackGetter]().forEach(function (track) {
                                                                                                        track.enabled = !mute;
                                                                                                        });
                                                                          });
                                           }},
                                           
                                           toggleMuteAudio: {writable: true, value: function toggleMuteAudio (mute) {
                                           this.toggleMuteHelper('getAudioTracks', mute);
                                           }},
                                           
                                           toggleMuteVideo: {writable: true, value: function toggleMuteVideo (mute) {
                                           this.toggleMuteHelper('getVideoTracks', mute);
                                           }}
                                           });

var sipconfiguration = {
    uri      : '1001@www.roam-tech.com',
ws_servers: 'ws://www.roam-tech.com:5066',
authorizationUser: '1001',
    password : '1234',
    hackStripTcp : true,
    iceCheckingTimeout : 1000,
	mediaHandlerFactory : MediaHandler.defaultFactory
};

var ua = new SIP.UA(sipconfiguration);
let currentSession;
function setupSessionListener(session) {
	currentSession = session;
	session.on('accepted', function() {
	  //if(currentSession.accept) {
        container.setState({status: 'incall', info: 'during a call'});
	  //}
    });
	session.on('bye', function() {
		currentSession=null;
        container.setState({status: 'ready', info: 'Please enter callee number'});
    });
	session.on('failed', function() {
		currentSession=null;
        container.setState({status: 'ready', info: 'Please enter callee number'});
    });
}
ua.on('registered',function () {
     container.setState({status: 'ready', info: 'Please enter callee number'});
});
ua.on('invite', function (session) {
	setupSessionListener(session);
    container.setState({status: 'ready', info: 'Incoming call '+session.remoteIdentity.uri});
});

function call(callee) {
	var options = {
	    media: {
		  constraints: {
		    audio: true,
		    video: false
		  }
	    },
		mediaHandlerFactory : MediaHandler.defaultFactory
	  };
    var session = ua.invite('sip:'+callee+'@www.roam-tech.com', options);
	setupSessionListener(session);
    console.log('call', session);
}
//var session = ua.invite('sip:5000@www.roam-tech.com', options);
/*
function getLocalStream(isFront, callback) {

  let videoSourceId;

  // on android, you don't have to specify sourceId manually, just use facingMode
  // uncomment it if you want to specify
  if (Platform.OS === 'ios') {
    MediaStreamTrack.getSources(sourceInfos => {
      console.log("sourceInfos: ", sourceInfos);

      for (const i = 0; i < sourceInfos.length; i++) {
        const sourceInfo = sourceInfos[i];
        if(sourceInfo.kind == "video" && sourceInfo.facing == (isFront ? "front" : "back")) {
          videoSourceId = sourceInfo.id;
        }
      }
    });
  }
  getUserMedia({
    audio: true,
    video: false
  }, function (stream) {
    console.log('getUserMedia success', stream);
    callback(stream);
  }, logError);
}

function join(roomID) {
  socket.emit('join', roomID, function(socketIds){
    console.log('join', socketIds);
    for (const i in socketIds) {
      const socketId = socketIds[i];
      createPC(socketId, true);
    }
  });
}

function createPC(socketId, isOffer) {
  const pc = new RTCPeerConnection(configuration);
  pcPeers[socketId] = pc;

  pc.onicecandidate = function (event) {
    console.log('onicecandidate', event.candidate);
    if (event.candidate) {
      socket.emit('exchange', {'to': socketId, 'candidate': event.candidate });
    }
  };

  function createOffer() {
    pc.createOffer(function(desc) {
      console.log('createOffer', desc);
      pc.setLocalDescription(desc, function () {
        console.log('setLocalDescription', pc.localDescription);
        socket.emit('exchange', {'to': socketId, 'sdp': pc.localDescription });
      }, logError);
    }, logError);
  }

  pc.onnegotiationneeded = function () {
    console.log('onnegotiationneeded');
    if (isOffer) {
      createOffer();
    }
  }

  pc.oniceconnectionstatechange = function(event) {
    console.log('oniceconnectionstatechange', event.target.iceConnectionState);
    if (event.target.iceConnectionState === 'completed') {
      setTimeout(() => {
        getStats();
      }, 1000);
    }
    if (event.target.iceConnectionState === 'connected') {
      createDataChannel();
    }
  };
  pc.onsignalingstatechange = function(event) {
    console.log('onsignalingstatechange', event.target.signalingState);
  };

  pc.onaddstream = function (event) {
    console.log('onaddstream', event.stream);
    container.setState({info: 'One peer join!'});

    const remoteList = container.state.remoteList;
    remoteList[socketId] = event.stream.toURL();
    container.setState({ remoteList: remoteList });
  };
  pc.onremovestream = function (event) {
    console.log('onremovestream', event.stream);
  };

  pc.addStream(localStream);
  function createDataChannel() {
    if (pc.textDataChannel) {
      return;
    }
    const dataChannel = pc.createDataChannel("text");

    dataChannel.onerror = function (error) {
      console.log("dataChannel.onerror", error);
    };

    dataChannel.onmessage = function (event) {
      console.log("dataChannel.onmessage:", event.data);
      container.receiveTextData({user: socketId, message: event.data});
    };

    dataChannel.onopen = function () {
      console.log('dataChannel.onopen');
      container.setState({textRoomConnected: true});
    };

    dataChannel.onclose = function () {
      console.log("dataChannel.onclose");
    };

    pc.textDataChannel = dataChannel;
  }
  return pc;
}

function exchange(data) {
  const fromId = data.from;
  let pc;
  if (fromId in pcPeers) {
    pc = pcPeers[fromId];
  } else {
    pc = createPC(fromId, false);
  }

  if (data.sdp) {
    console.log('exchange sdp', data);
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp), function () {
      if (pc.remoteDescription.type == "offer")
        pc.createAnswer(function(desc) {
          console.log('createAnswer', desc);
          pc.setLocalDescription(desc, function () {
            console.log('setLocalDescription', pc.localDescription);
            socket.emit('exchange', {'to': fromId, 'sdp': pc.localDescription });
          }, logError);
        }, logError);
    }, logError);
  } else {
    console.log('exchange candidate', data);
    pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

function leave(socketId) {
  console.log('leave', socketId);
  const pc = pcPeers[socketId];
  const viewIndex = pc.viewIndex;
  pc.close();
  delete pcPeers[socketId];

  const remoteList = container.state.remoteList;
  delete remoteList[socketId]
  container.setState({ remoteList: remoteList });
  container.setState({info: 'One peer leave!'});
}

socket.on('exchange', function(data){
  exchange(data);
});
socket.on('leave', function(socketId){
  leave(socketId);
});

socket.on('connect', function(data) {
  console.log('connect');
  getLocalStream(true, function(stream) {
    localStream = stream;
    container.setState({selfViewSrc: stream.toURL()});
    container.setState({status: 'ready', info: 'Please enter or create room ID'});
  });
});
*/
function logError(error) {
  console.log("logError", error);
}

function mapHash(hash, func) {
  const array = [];
  for (const key in hash) {
    const obj = hash[key];
    array.push(func(obj, key));
  }
  return array;
}

function getStats() {
  const pc = pcPeers[Object.keys(pcPeers)[0]];
  if (pc.getRemoteStreams()[0] && pc.getRemoteStreams()[0].getAudioTracks()[0]) {
    const track = pc.getRemoteStreams()[0].getAudioTracks()[0];
    console.log('track', track);
    pc.getStats(track, function(report) {
      console.log('getStats report', report);
    }, logError);
  }
}

let container;

const RCTWebRTCDemo = React.createClass({
  getInitialState: function() {
    this.ds = new ListView.DataSource({rowHasChanged: (r1, r2) => true});
    return {
      info: 'Initializing',
      status: 'init',
      roomID: '',
      isFront: true,
      selfViewSrc: null,
      remoteList: {},
      textRoomConnected: false,
      textRoomData: [],
      textRoomValue: '',
    };
  },
  componentDidMount: function() {
    container = this;
  },
  _press(event) {
    this.refs.roomID.blur();
	if(currentSession == null) {
      this.setState({status: 'outgoing', info: 'Outgoing'});
	  call(this.state.roomID);
	} else if(currentSession.accept && !currentSession.startTime){
	  var options = {
	    media: {
		  constraints: {
		    audio: true,
		    video: false
		  }
	    }
	  };
	  currentSession.accept(options);
	} else if (currentSession.startTime) { // Connected
      currentSession.bye();
    } else if (currentSession.reject) { // Incoming
      currentSession.reject();
    } else if (currentSession.cancel) { // Outbound
      currentSession.cancel();
    }   
  },
  _switchVideoType() {
    const isFront = !this.state.isFront;
    this.setState({isFront});
    getLocalStream(isFront, function(stream) {
      if (localStream) {
        for (const id in pcPeers) {
          const pc = pcPeers[id];
          pc && pc.removeStream(localStream);
        }
        localStream.release();
      }
      localStream = stream;
      container.setState({selfViewSrc: stream.toURL()});

      for (const id in pcPeers) {
        const pc = pcPeers[id];
        pc && pc.addStream(localStream);
      }
    });
  },
  receiveTextData(data) {
    const textRoomData = this.state.textRoomData.slice();
    textRoomData.push(data);
    this.setState({textRoomData, textRoomValue: ''});
  },
  _textRoomPress() {
    if (!this.state.textRoomValue) {
      return
    }
    const textRoomData = this.state.textRoomData.slice();
    textRoomData.push({user: 'Me', message: this.state.textRoomValue});
    for (const key in pcPeers) {
      const pc = pcPeers[key];
      pc.textDataChannel.send(this.state.textRoomValue);
    }
    this.setState({textRoomData, textRoomValue: ''});
  },
  _renderTextRoom() {
    return (
      <View style={styles.listViewContainer}>
        <ListView
          dataSource={this.ds.cloneWithRows(this.state.textRoomData)}
          renderRow={rowData => <Text>{`${rowData.user}: ${rowData.message}`}</Text>}
          />
        <TextInput
          style={{width: 200, height: 30, borderColor: 'gray', borderWidth: 1}}
          onChangeText={value => this.setState({textRoomValue: value})}
          value={this.state.textRoomValue}
        />
        <TouchableHighlight
          onPress={this._textRoomPress}>
          <Text>Send</Text>
        </TouchableHighlight>
      </View>
    );
  },
  render() {
    return (
      <View style={styles.container}>
        <Text style={styles.welcome}>
          {this.state.info}
        </Text>
        {this.state.textRoomConnected && this._renderTextRoom()}
        { this.state.status == 'ready' ?
          (<View>
            <TextInput
              ref='roomID'
              autoCorrect={false}
              style={{width: 200, height: 40, borderColor: 'gray', borderWidth: 1}}
              onChangeText={(text) => this.setState({roomID: text})}
              value={this.state.roomID}
            />
            <TouchableHighlight
              onPress={this._press}>
			  <Text>{currentSession != null?"Accept":"Invite"}</Text>
            </TouchableHighlight>
          </View>) : null
        }
		{
			this.state.status == 'incall' ?
          (<View>
            <TextInput
              ref='roomID'
              autoCorrect={false}
              style={{width: 200, height: 40, borderColor: 'gray', borderWidth: 1}}
              onChangeText={(text) => this.setState({roomID: text})}
              value={this.state.roomID}
            />
            <TouchableHighlight
              onPress={this._press}>
              <Text>Bye</Text>
            </TouchableHighlight>
          </View>) : null
        }
        <RTCView streamURL={this.state.selfViewSrc} style={styles.selfView}/>
        {
          mapHash(this.state.remoteList, function(remote, index) {
            return <RTCView key={index} streamURL={remote} style={styles.remoteView}/>
          })
        }
      </View>
    );
  }
});

const styles = StyleSheet.create({
  selfView: {
    width: 200,
    height: 150,
  },
  remoteView: {
    width: 200,
    height: 150,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#F5FCFF',
  },
  welcome: {
    fontSize: 20,
    textAlign: 'center',
    margin: 10,
  },
  listViewContainer: {
    height: 150,
  },
});

AppRegistry.registerComponent('RCTWebRTCDemo', () => RCTWebRTCDemo);
