import * as http from 'http';
import * as WebSocket from 'ws';
import { Subject, Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { combineEffects, combineMiddlewares, Event, createEffectContext, createListener } from '@marblejs/core';
import * as WS from '../websocket.interface';
import * as WSEffect from '../effects/websocket.effects.interface';
import { jsonTransformer } from '../transformer/websocket.json.transformer';
import { EventTransformer } from '../transformer/websocket.transformer.interface';
import { handleResponse, handleBroadcastResponse } from '../response/websocket.response.handler';
import { handleEffectsError } from '../error/websocket.error.handler';
import { provideErrorEffect } from '../error/websocket.error.provider';
import { WebSocketConnectionError } from '../error/websocket.error.model';
import * as WSHelper from './websocket.server.helper';

type HandleMessage =
  (client: WS.MarbleWebSocketClient) => void;

type HandleConnection =
  (server: WS.MarbleWebSocketServer) => (client: WS.WebSocketClient, request: http.IncomingMessage) => void;

export interface WebSocketListenerConfig {
  effects?: WSEffect.WsEffect<any, any>[];
  middlewares?: WSEffect.WsMiddlewareEffect<any, any>[];
  error$?: WSEffect.WsErrorEffect<Error, any, any>;
  eventTransformer?: EventTransformer<Event, any>;
  connection$?: WSEffect.WsConnectionEffect;
  output$?: WSEffect.WsOutputEffect;
}

export interface WebSocketListener {
  (options?: WebSocket.ServerOptions): WS.MarbleWebSocketServer;
}

export const webSocketListener = createListener<WebSocketListenerConfig, WebSocketListener>(config => ask => {
  const {
    error$,
    effects = [],
    middlewares = [],
    eventTransformer,
    connection$ = (req$: Observable<http.IncomingMessage>) => req$,
    output$ = (out$: Observable<Event>) => out$,
  } = config ?? {};

  const combinedMiddlewares = combineMiddlewares(...middlewares);
  const combinedEffects = combineEffects(...effects);
  const providedError$ = provideErrorEffect(error$, eventTransformer);
  const providedTransformer: EventTransformer<any, any> = eventTransformer || jsonTransformer;

  const handleMessage: HandleMessage = client => {
    const eventSubject$ = new Subject<any>();
    const incomingEventSubject$ = new Subject<WS.WebSocketData>();
    const ctx = createEffectContext({ ask, client });
    const decodedEvent$ = incomingEventSubject$.pipe(map(providedTransformer.decode));
    const middlewares$ = combinedMiddlewares(decodedEvent$, ctx);
    const effects$ = combinedEffects(eventSubject$, ctx);
    const effectsOutput$ = output$(effects$, ctx);

    const subscribeMiddlewares = (input$: Observable<any>) =>
      input$.subscribe(
        event => eventSubject$.next(event),
        error => handleEffectsError(ctx, providedError$)(error),
      );

    const subscribeEffects = (input$: Observable<any>) =>
      input$.subscribe(
        event => client.sendResponse(event),
        error => handleEffectsError(ctx, providedError$)(error),
      );

    let middlewaresSub = subscribeMiddlewares(middlewares$);
    let effectsSub = subscribeEffects(effectsOutput$);

    const onMessage = (event: WS.WebSocketData) => {
      if (middlewaresSub.closed) { middlewaresSub = subscribeMiddlewares(middlewares$); }
      if (effectsSub.closed) { effectsSub = subscribeEffects(effects$); }
      incomingEventSubject$.next(event);
    };

    const onClose = () => {
      client.removeListener('message', onMessage);
      middlewaresSub.unsubscribe();
      effectsSub.unsubscribe();
    };

    client.on('message', onMessage);
    client.once('close', onClose);
  };

  const handleConnection: HandleConnection = server => client => {
    const extendedClient = WSHelper.extendClientWith({
      sendResponse: handleResponse(client, providedTransformer),
      sendBroadcastResponse: handleBroadcastResponse(server, providedTransformer),
      isAlive: true,
    })(client);

    handleMessage(extendedClient);
    WSHelper.handleClientBrokenConnection(extendedClient).subscribe();
  };

  const verifyClient: WebSocket.VerifyClientCallbackAsync = (info, callback) => {
    connection$(of(info.req), createEffectContext({ ask, client: undefined }))
      .pipe(map(Boolean))
      .subscribe(
        isVerified => callback(isVerified),
        (error: WebSocketConnectionError) => callback(false, error.status, error.message),
      );
  };

  return (serverOptions: WebSocket.ServerOptions = {}) => {
    const webSocketServer = WSHelper.createWebSocketServer({
      noServer: true,
      verifyClient,
      ...serverOptions,
    });
    const sendBroadcastResponse = handleBroadcastResponse(webSocketServer, providedTransformer);
    const extendedWebSocketServer = WSHelper.extendServerWith({ sendBroadcastResponse })(webSocketServer);

    extendedWebSocketServer.on('connection', handleConnection(extendedWebSocketServer));
    WSHelper.handleServerBrokenConnections(extendedWebSocketServer).subscribe();

    return extendedWebSocketServer;
  };
});