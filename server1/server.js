/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs = require('fs');
var https = require('https');
const redis = require("redis");
const publisher = redis.createClient();
const subscriber = redis.createClient();
const puppeteer = require('puppeteer');
var open = require('open');
const { info } = require('console');

var argv = minimist(process.argv.slice(2), {
	default: {
		as_uri: 'https://192.168.1.25:8000',
		ws_uri: 'ws://192.168.1.25:8888/kurento'
	}
});


var options =
{
	key: fs.readFileSync('keys/server.key'),
	cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function () {
	console.log('Kurento Tutorial started');
	console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
	server: server,
	path: '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

var serve1_info = {
	id : "serve1",
	viewer_count : 0,
	ip: argv.as_uri,
}
var serve2_info = {
	id : "",
	viewer_count : 0,
	ip: '',
}
var serve3_info = {
	id : "",
	viewer_count : 0,
	ip: '',
}
var max_viewer_serve = 3
var check_send_stream = false


/*
 * Management of WebSocket messages
 */
wss.on('connection', function (ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);

	ws.on('error', function (error) {
		console.log('Connection ' + sessionId + ' error');
		stop(sessionId);
	});

	ws.on('close', function () {
		console.log('Connection ' + sessionId + ' closed');
		serve1_info.viewer_count--;
		console.log("close viewer");
		console.log(serve1_info);
		console.log(serve2_info);
		stop(sessionId);
	});

	ws.on('message', function (_message) {
		var message = JSON.parse(_message);
		// console.log('Connection ' + sessionId + ' received message ', message);

		switch (message.id) {
			case 'presenter':
				startPresenter(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id: 'presenterResponse',
							response: 'rejected',
							message: error
						}));
					}
					if(check_send_stream == false){
						setTimeout(() => {
							console.log("~~~~~~~~~~~~~~~~~~ call on test ~~~~~~~~~~~~~~~~~~`")
							serve1_info.viewer_count--;
							check_send_stream = true;
							getCandidate();
						}, 1000);
					}
					
					ws.send(JSON.stringify({
						id: 'presenterResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;

			case 'viewer':
				startViewer(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id: 'viewerResponse',
							response: 'rejected',
							message: error
						}));
					}
					if(serve1_info.viewer_count < max_viewer_serve){
						serve1_info.viewer_count++;
					}
					console.log("click viewer");
					console.log(serve1_info);
					console.log(serve2_info);
					// if(serve1_info.viewer_count == max_viewer_serve && check_send_stream == false){
						// setTimeout(() => {
						// 	console.log("~~~~~~~~~~~~~~~~~~ call on test ~~~~~~~~~~~~~~~~~~`")
						// serve1_info.viewer_count--;
						// check_send_stream = true;
						// 	getCandidate();
						// }, 1000);
					// }

					ws.send(JSON.stringify({
						id: 'viewerResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;

			case 'stop':
				stop(sessionId);
				break;

			case 'onIceCandidate':
				onIceCandidate(sessionId, message.candidate);
				break;

			default:
				ws.send(JSON.stringify({
					id: 'error',
					message: 'Invalid message ' + message
				}));
				break;
		}
	});
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
	if (kurentoClient !== null) {
		return callback(null, kurentoClient);
	}

	kurento(argv.ws_uri, function (error, _kurentoClient) {
		if (error) {
			console.log("Could not find media server at address " + argv.ws_uri);
			return callback("Could not find media server at address" + argv.ws_uri
				+ ". Exiting with error " + error);
		}

		kurentoClient = _kurentoClient;
		callback(null, kurentoClient);
	});
}

function startPresenter(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);
	if (presenter !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as presenter. Try again later ...");
	}

	presenter = {
		id: sessionId,
		pipeline: null,
		webRtcEndpoint: null
	}

	getKurentoClient(function (error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function (error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.pipeline = pipeline;
			pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				presenter.webRtcEndpoint = webRtcEndpoint;

				if (candidatesQueue[sessionId]) {
					while (candidatesQueue[sessionId].length) {
						var candidate = candidatesQueue[sessionId].shift();
						webRtcEndpoint.addIceCandidate(candidate);
					}
				}

				webRtcEndpoint.on('OnIceCandidate', function (event) {
					var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
					ws.send(JSON.stringify({
						id: 'iceCandidate',
						candidate: candidate
					}));
				});

				webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}

					if (presenter === null) {
						stop(sessionId);
						return callback(noPresenterMessage);
					}

					webRtcEndpoint.getConnectionState(function encoderStateChanged(err, state) {
						if (err) {
							console.error(err);
						}
						console.log(`encoder connection state: ${state}`);
					});

					callback(null, sdpAnswer);
				});

				webRtcEndpoint.gatherCandidates(function (error) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}
				});
			});
		});
	});

}

async function getCandidate() {
	const browser = await puppeteer.launch({ headless: true, args: ['--ignore-certificate-errors'] });
	const page = await (await browser.pages())[0]
	await page.addScriptTag({ url: "https://192.168.1.25:8000/js/kurento-utils.js" });
	page.on('console', message => console.log(message.text()))
	const info = await page.evaluate(async () => {
		(function(){
			var ws = new WebSocket('wss://192.168.1.25:8000/one2many');
			var webRtcPeer;
			ws.onmessage = function (message) {
				var parsedMessage = JSON.parse(message.data);
				// console.info('Received message: ' + message.data);

				switch (parsedMessage.id) {
					case 'viewerResponse':
						response(webRtcPeer, parsedMessage);
						break;
					case 'stopCommunication':
						dispose();
						break;
					case 'iceCandidate':
						webRtcPeer.addIceCandidate(parsedMessage.candidate)
						break;
					default:
						console.error('Unrecognized message', parsedMessage);
				}
			}

			var options = {
				onicecandidate: onIceCandidate.bind(null, ws)
			}

			webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function (error) {
				if (error) return onError(error);

				this.generateOffer(onOfferViewer);
			});

			function onOfferViewer(error, offerSdp) {
				if (error) return onError(error)

				var message = {
					id: 'viewer',
					sdpOffer: offerSdp
				}
				sendMessage(ws, message);
			}
		})();

		(function(){
			document.addEventListener("remote-stream", async function (e) {
				const stream =  e.detail.stream;
				presenter(stream);
			});
			var ws = new WebSocket('wss://192.168.1.25:9000/one2many');
			var webRtcPeer;

			window.onbeforeunload = function () {
				ws.close();
			}

			ws.onmessage = function (message) {
				var parsedMessage = JSON.parse(message.data);
				console.info('Received message: ' + message.data);

				switch (parsedMessage.id) {
					case 'presenterResponse':
						response(webRtcPeer, parsedMessage);
						break;
					case 'stopCommunication':
						dispose();
						break;
					case 'iceCandidate':
						webRtcPeer.addIceCandidate(parsedMessage.candidate)
						break;
					default:
						console.error('Unrecognized message', parsedMessage);
				}
			}

			function presenter(stream) {
				if (!webRtcPeer) {
					var options = {
						videoStream: stream,
						onicecandidate: onIceCandidate.bind(null, ws)
					}

					webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function (error) {
						if (error) return onError(error);
						this.generateOffer(onOfferPresenter);
					});
				}
			}

			function onOfferPresenter(error, offerSdp) {
				if (error) return onError(error);

				var message = {
					id: 'presenter',
					sdpOffer: offerSdp
				};
				sendMessage(ws, message);
			}
		})();

		function onIceCandidate(ws, candidate) {
			var message = {
				id: 'onIceCandidate',
				candidate: candidate
			}
			sendMessage(ws, message);
		}

		function sendMessage(ws, message) {
			var jsonMessage = JSON.stringify(message);
			ws.send(jsonMessage);
		}

		function response(webRtcPeer, message){
			if (message.response != 'accepted') {
				dispose();
			} else {
				webRtcPeer.processAnswer(message.sdpAnswer);
			}
		}

		function dispose(webRtcPeer) {
			if (webRtcPeer) {
				webRtcPeer.dispose();
				webRtcPeer = null;
			}
		}
	});
}

function startViewer(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (presenter === null) {
		stop(sessionId);
		return callback(noPresenterMessage);
	}

	presenter.pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		viewers[sessionId] = {
			"webRtcEndpoint": webRtcEndpoint,
			"ws": ws
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[sessionId]) {
			while (candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

		webRtcEndpoint.on('OnIceCandidate', function (event) {
			var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
			ws.send(JSON.stringify({
				id: 'iceCandidate',
				candidate: candidate
			}));
		});

		webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.webRtcEndpoint.connect(webRtcEndpoint, function (error) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
				webRtcEndpoint.gatherCandidates(function (error) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}
				});
			});
		});
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

async function stop(sessionId) {
	if (presenter !== null && presenter.id == sessionId) {
		for (var i in viewers) {
			var viewer = viewers[i];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id: 'stopCommunication'
				}));
			}
		}
		presenter.pipeline.release();
		presenter = null;
		viewers = [];
		publisher.publish("stop", '1998', function () {

		});
	} else if (viewers[sessionId]) {
		viewers[sessionId].webRtcEndpoint.release();
		delete viewers[sessionId];
	}

	clearCandidatesQueue(sessionId);

	if (viewers.length < 1 && !presenter) {
		console.log('Closing kurento client');
		if (kurentoClient) {
			await kurentoClient.close();
			kurentoClient = null;
		}
	}
}

function onIceCandidate(sessionId, _candidate) {
	var candidate = kurento.getComplexType('IceCandidate')(_candidate);

	if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
		console.info('Sending presenter candidate');
		presenter.webRtcEndpoint.addIceCandidate(candidate);
	}
	else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
		console.info('Sending viewer candidate');
		viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
	}
	else {
		console.info('Queueing candidate');
		if (!candidatesQueue[sessionId]) {
			candidatesQueue[sessionId] = [];
		}
		candidatesQueue[sessionId].push(candidate);
	}
}

app.get('/test', (request, response) => {
	console.log("call api");
	console.log(serve1_info);
	console.log(serve2_info);
	if(serve1_info.viewer_count < max_viewer_serve){
		response.send(serve1_info);
	}else{
		if(serve2_info.viewer_count < max_viewer_serve){
			serve1_info.viewer_count++
			response.send(serve2_info);
		}else{
			serve1_info.viewer_count++
			response.send(serve3_info);
		}
	}
});

subscriber.subscribe("serve2-count");
subscriber.subscribe("serve3-count");
subscriber.subscribe("iceCandidate");
subscriber.subscribe("presenterResponse");
subscriber.on("message", async function (channel, message) {
	switch (channel) {
		case 'presenterResponse':
			console.log("presenterResponse")
			presenter.webRtcEndpoint.processAnswer(message);
			break;
		case 'iceCandidate':
			// console.log(JSON.parse(message))
			presenter.webRtcEndpoint.addIceCandidate(JSON.parse(message));
		case 'serve2-count':
			message = JSON.parse(message)
			serve2_info =  message
			console.log(message);
			break;
		case 'serve3-count':
			message = JSON.parse(message)
			serve3_info =  message
			console.log(message);
			break;
		default:
			break;
	}
});

app.use(express.static(path.join(__dirname, 'static')));
