import {EventEmitter, EventKey} from "event-emitter-typescript";
import {ValidationError, Validator} from "checkeasy";
import {ErrorEvent} from "undici-types/websocket";

export type WebSocketHeadEventType = {event: string};
export type WebSocketHeadType = WebSocketHeadEventType | {operation: string, operationConfig: string};

export type BackendiumWebSocketEvents<InitDataType> = {
    notEventMessage: [Buffer, BackendiumWebSocket<InitDataType>],
    unknownEvent: [Buffer, BackendiumWebSocket<InitDataType>, WebSocketHeadEventType],
    parsingFailed: [Buffer, BackendiumWebSocket<InitDataType>, Validator<any> | undefined],
    initParsingFailed: [Buffer, WebSocket, Validator<any> | undefined],
    initFailed: [Buffer, WebSocket],
    accept: [BackendiumWebSocket<InitDataType>, WebSocketConstructor<InitDataType>],
    message: [Buffer, BackendiumWebSocket<InitDataType>],
    messageBeforeEvents: [Buffer, BackendiumWebSocket<InitDataType>],
    close: [BackendiumWebSocket<InitDataType>, number, Buffer],
    error: [BackendiumWebSocket<InitDataType>, ErrorEvent],
    init: [WebSocket, Buffer, string, (socket: BackendiumWebSocket<InitDataType>) => void, () => void],
    open: [BackendiumWebSocket<InitDataType>]
}

export class BackendiumWebSocket<InitDataType> {
    protected eventEmitter = new EventEmitter<BackendiumWebSocketEvents<InitDataType>>;
    protected wsEventEmitter = new EventEmitter<WebSocketEvents<InitDataType>>;
    protected events = new Set<string>;
    protected operations = new EventEmitter<WebSocketOperations<InitDataType>>;
    protected useEvents = false;

    public static rawDataParse(data: any): Buffer {
        return data instanceof Buffer ? data : data instanceof ArrayBuffer ? Buffer.from(data) : typeof data === "string" ? Buffer.from(data) : data;
    }

    protected parseEventHead(head: string, message: Buffer, socket: BackendiumWebSocket<InitDataType>): WebSocketHeadType | undefined {
        if (head.length < 1 || !head.startsWith("$")) {
            this.eventEmitter.emit("notEventMessage", [message, socket]);
            this.wsConstructor.eventEmitter.emit("notEventMessage", [message, socket]);
            return;
        }
        let [, name, ...other] = head.split('$');
        if (name.length) return {event: name.trim()};
        let [operation, ...operationConfig] = other;
        return {operation: operation.trim(), operationConfig: operationConfig.join('$').trim()};
    }

    protected emitIncomingEvent(event: string, payload: Buffer, socket: BackendiumWebSocket<InitDataType>, head: WebSocketHeadEventType) {
        if (this.events.has(event)) this.wsEventEmitter.emit(event, [payload, socket]);
        else {
            this.eventEmitter.emit("unknownEvent", [payload, socket, head]);
            this.wsConstructor.eventEmitter.emit("unknownEvent", [payload, socket, head]);
        }
    }

    protected emitIncomingOperation(operation: string, payload: Buffer, operationConfig: string, socket: BackendiumWebSocket<InitDataType>) {
        this.operations.emit(operation, [payload, operationConfig, socket]);
    }

    protected parseEventMessage(message: Buffer, socket: BackendiumWebSocket<InitDataType>): void {
        try {
            let [head_, ...data] = message.toString().split("\n");
            let payload = Buffer.from(data.join("\n")), head = this.parseEventHead(head_, message, socket);
            if (!head) {
                return;
            }
            if ("event" in head) {
                this.emitIncomingEvent(head.event, payload, socket, head);
            }
            else this.emitIncomingOperation(head.operation, payload, head.operationConfig, socket);
        } catch (error) {
            this.eventEmitter.emit("notEventMessage", [message, socket]);
            this.wsConstructor.eventEmitter.emit("notEventMessage", [message, socket]);
            return;
        }
    }

    constructor(public socket: WebSocket, public wsConstructor: WebSocketConstructor<InitDataType>, public initData: InitDataType, public url: string) {
        this.eventEmitter.emit("accept", [this, this.wsConstructor]);
        this.wsConstructor.eventEmitter.emit("accept", [this, this.wsConstructor]);
        socket.onmessage = (message) => {
            let buffer = BackendiumWebSocket.rawDataParse(message.data);
            if (this.useEvents) {
                this.eventEmitter.emit("messageBeforeEvents", [buffer, this]);
                this.wsConstructor.eventEmitter.emit("messageBeforeEvents", [buffer, this]);
                this.parseEventMessage(buffer, this);
            }
            else {
                this.eventEmitter.emit("notEventMessage", [buffer, this]);
                this.wsConstructor.eventEmitter.emit("notEventMessage", [buffer, this]);
            }
            this.eventEmitter.emit("message", [buffer, this]);
            this.wsConstructor.eventEmitter.emit("message", [buffer, this]);
        };
        socket.onclose = (closeEvent) => {
            this.eventEmitter.emit("close", [this, closeEvent.code, Buffer.from(closeEvent.reason)]);
            this.wsConstructor.eventEmitter.emit("close", [this, closeEvent.code, Buffer.from(closeEvent.reason)]);
            // app.logger.wsClose(url);
        };
        socket.onopen = () => {
            this.eventEmitter.emit("open", [this]);
            this.wsConstructor.eventEmitter.emit("open", [this]);
        };
        socket.onerror = (errorEvent) => {
            this.eventEmitter.emit("error", [this, errorEvent]);
            this.wsConstructor.eventEmitter.emit("error", [this, errorEvent]);
        }
    }

    public static eventNameCheck(str: string) {
        if (str.includes("$")) throw new Error("event name cannot contain '$'");
    }

    public event<Type extends Buffer>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>) => void): void;
    public event<Type>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>, validator: Validator<Type>) => void, validator: Validator<Type>): void;

    public event<Type>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>, validator: Validator<Type>) => void, validator?: Validator<Type>): void {
        this.useEvents = true;
        event = event.trim();
        BackendiumWebSocket.eventNameCheck(event);
        this.events.add(event);
        this.wsEventEmitter.on(event, ([data, socket]) => {
            let [mainData, parsed] = validator ? parse(data, validator) : [data, true];
            if (!parsed || !mainData) {
                this.eventEmitter.emit("parsingFailed", [data, socket, validator]);
                this.wsConstructor.eventEmitter.emit("parsingFailed", [data, socket, validator]);
                return;
            }
            // @ts-ignore
            callback(mainData, socket, validator ?? bufferValidator);
        });
    }

    public operation<E extends EventKey<WebSocketOperations<InitDataType>>>(event: E, subscriber: (...args: WebSocketOperations<InitDataType>[E]) => void): void {
        BackendiumWebSocket.eventNameCheck(event);
        this.operations.on(event, (args) => subscriber(...args));
    };

    public on<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): () => void {
        return this.eventEmitter.on(event, (args) => subscriber(...args));
    };

    public once<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): () => void {
        return this.eventEmitter.once(event, (args) => subscriber(...args));
    };

    public off<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): void {
        this.eventEmitter.off(event, (args) => subscriber(...args));
    };

    protected _send(data: any) {
        if (!(data instanceof Buffer) && typeof data === "object" || typeof data === "boolean") data = JSON.stringify(data);
        this.socket.send(data);
    }

    send(data: any) {
        this._send(data);
    }

    protected static AnyToString(data: any): string {
        return typeof data === "string" ? data : data instanceof Buffer ? data.toString() : data === undefined ? "undefined" : (typeof data === "number" && isNaN(data)) ? "NaN" : JSON.stringify(data);
    }

    emit(event: string, payload?: any) {
        BackendiumWebSocket.eventNameCheck(event);
        this._send(`$${event}\n${BackendiumWebSocket.AnyToString(payload)}`);
    }

    emitOperation(event: string, operationConfig: any, payload: any) {
        BackendiumWebSocket.eventNameCheck(event);
        this._send(`$$${event}$${BackendiumWebSocket.AnyToString(operationConfig)}\n${BackendiumWebSocket.AnyToString(payload)}`);
    }
}

export type WebSocketEvents<InitDataType> = {
    [key: string]: [Buffer, BackendiumWebSocket<InitDataType>];
};

export type WebSocketOperations<InitDataType> = {
    [key: string]: [Buffer, string, BackendiumWebSocket<InitDataType>];
};

const bufferValidator: Validator<Buffer> = (value: any, path: string) => {
    if (value instanceof Buffer) return value;
    throw new ValidationError(`[${path}] is not buffer`);
};

function parse<Type>(data: Buffer, validator: Validator<Type>): [Type, true] | [null, false] {
    try {
        return [validator(data, ""), true];
    }
    catch (error) {
        try {
            return [validator(data.toString(), ""), true];
        }
        catch (error) {
            try {
                return [validator(JSON.parse(data.toString()), ""), true];
            }
            catch (error) {
                return [null, false];
            }
        }
    }
}

export class WebSocketConstructor<InitDataType = undefined> {
    protected sockets: Array<BackendiumWebSocket<InitDataType>> = []
    public eventEmitter = new EventEmitter<BackendiumWebSocketEvents<InitDataType>>;
    protected eventHandlers: Array<[string, (data: any, socket: BackendiumWebSocket<InitDataType>, validator: Validator<any>) => void, Validator<any> | undefined]> = []
    protected operations = new EventEmitter<WebSocketOperations<InitDataType>>;

    protected _backendiumWebsocket(socket: WebSocket, initData: InitDataType, url: string): BackendiumWebSocket<InitDataType> {
        let backendiumSocket = new BackendiumWebSocket<InitDataType>(socket, this, initData, url);
        // @ts-ignore
        this.eventHandlers.forEach(([event, socket, validator]) => backendiumSocket.event(event, socket, validator));
        return backendiumSocket;
    }

    public send(url: string, initData?: InitDataType): Promise<BackendiumWebSocket<InitDataType>> {
        return new Promise((resolve) => {
            const socket = new WebSocket(url);
            // @ts-ignore
            const backendiumSocket = this._backendiumWebsocket(socket, undefined, url);
            backendiumSocket.on("open", () => {
                if (initData !== undefined) backendiumSocket.send(initData);
                resolve(backendiumSocket);
            });
        });
    }

    public event<Type extends Buffer>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>) => void): WebSocketConstructor<InitDataType>;
    public event<Type>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>, validator: Validator<Type>) => void, validator: Validator<Type>): WebSocketConstructor<InitDataType>;

    public event<Type>(event: string, callback: (data: Type, socket: BackendiumWebSocket<InitDataType>, validator: Validator<Type>) => void, validator?: Validator<Type>): WebSocketConstructor<InitDataType> {
        BackendiumWebSocket.eventNameCheck(event);
        // @ts-ignore
        this.sockets.forEach(socket => socket.event(event, callback, validator));
        this.eventHandlers.push([event, callback, validator]);
        return this;
    }

    public operation<E extends EventKey<WebSocketOperations<InitDataType>>>(event: E, subscriber: (...args: WebSocketOperations<InitDataType>[E]) => void): void {
        BackendiumWebSocket.eventNameCheck(event);
        this.operations.on(event, (args) => subscriber(...args));
    }

    public on_<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): () => void {
        return this.eventEmitter.on(event, (args) => subscriber(...args));
    }

    public once_<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): () => void {
        return this.eventEmitter.once(event, (args) => subscriber(...args));
    }

    public on<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): WebSocketConstructor<InitDataType> {
        this.eventEmitter.on(event, (args) => subscriber(...args));
        return this;
    }

    public once<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): WebSocketConstructor<InitDataType> {
        this.eventEmitter.once(event, (args) => subscriber(...args));
        return this;
    }

    public off<E extends EventKey<BackendiumWebSocketEvents<InitDataType>>>(event: E, subscriber: (...args: BackendiumWebSocketEvents<InitDataType>[E]) => void): WebSocketConstructor<InitDataType> {
        this.eventEmitter.off(event, (args) => subscriber(...args));
        return this;
    }
}

// @TODO error handling