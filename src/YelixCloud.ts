import type { OpenAPICore } from 'jsr:@yelix/openapi';
import { hostname, platform, networkInterfaces } from 'node:os';

// deno-lint-ignore require-await
async function getMachineIP(): Promise<string | null> {
  const interfaces = networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!Array.isArray(ifaceList)) continue;
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.address.startsWith('127.')) {
        return iface.address;
      }
    }
  }
  return null;
}

const machineName = hostname();
const machineIP = await getMachineIP();
const machinePlatform = platform();

type RequestData = {
  startTime: number;
  path: string;
  duration: number; // float
  method: string;
};

type QueuedRequest = {
  request: RequestData;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
};

export class YelixCloud {
  private instanceId: string | 'Not-Initialized' | 'Initializing' =
    'Not-Initialized';
  private apiKey: string;
  private requestQueue: QueuedRequest[] = [];
  private isProcessingQueue = false;
  private BASE_URL = 'https://backend.yelix.deno.net';
  private debug: boolean;

  constructor({
    apiKey,
    baseUrl,
    debug,
  }: {
    apiKey: string;
    baseUrl?: string;
    debug?: boolean;
  }) {
    if (!apiKey) {
      throw new Error('API key is required to initialize YelixCloud');
    }
    this.apiKey = apiKey;
    if (baseUrl) {
      this.BASE_URL = baseUrl;
    }
    this.debug = debug || false;
    
    this.log('log', 'YelixCloud instance created', {
      baseUrl: this.BASE_URL,
      debug: this.debug,
      hasApiKey: !!apiKey
    });
  }

  // deno-lint-ignore no-explicit-any
  private log(type: 'log' | 'warn' | 'error', ...args: any[]) {
    if (this.debug) {
      console[type]('[@yelix/sdk]', ...args);
    } 
  }

  private async initialize(environment: string, schema: OpenAPICore) {
    if (this.instanceId !== 'Not-Initialized') {
      this.log('warn',
        '[@yelix/sdk] YelixCloud is already initialized or in the process of initializing.'
      );
      return;
    }
    
    this.log('log', 'Starting YelixCloud initialization', { environment });
    this.instanceId = 'Initializing';

    try {
      this.log('log', 'Sending initialization request to', this.BASE_URL + '/v1/instances/create');
      
      const response = await fetch(this.BASE_URL + '/v1/instances/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          environment,
          machineName,
          machineIP,
          machineOS: machinePlatform,
          schema,
        }),
      });

      if (!response.ok) {
        this.log('warn',
          '[@yelix/sdk] Failed to initialize YelixCloud:',
          response.statusText
        );
        return;
      }

      const data = await response.json();
      this.instanceId = data.data.instance_id;
      
      this.log('log', 'YelixCloud initialized successfully', { 
        instanceId: this.instanceId,
        queuedRequests: this.requestQueue.length 
      });

      // Process any queued requests
      this.processQueue();
    } catch (error) {
      this.log('error', 'Failed to initialize YelixCloud:', error);
      this.instanceId = 'Initialize-Failed';
      return;
    }
  }
  
  private processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      this.log('log', 'Queue processing skipped', { 
        isProcessing: this.isProcessingQueue, 
        queueLength: this.requestQueue.length 
      });
      return;
    }

    this.log('log', 'Starting queue processing', { queueLength: this.requestQueue.length });
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const queuedRequest = this.requestQueue.shift();
      if (!queuedRequest) continue;

      this.log('log', 'Processing queued request', { 
        method: queuedRequest.request.method,
        path: queuedRequest.request.path 
      });

      // Fire and forget - don't await
      this.sendRequest(queuedRequest.request)
        .then((result) => {
          this.log('log', 'Queued request completed', { success: result });
          queuedRequest.resolve(result);
        })
        .catch((error) => {
          this.log('error', 'Queued request failed', error);
          queuedRequest.reject(
            error instanceof Error ? error : new Error(String(error))
          );
        });
    }

    this.isProcessingQueue = false;
    this.log('log', 'Queue processing completed');
  }

  private async sendRequest(_request: RequestData): Promise<boolean> {
    this.log('log', 'Sending request', { 
      method: _request.method, 
      path: _request.path, 
      duration: _request.duration,
      instanceId: this.instanceId 
    });
    
    try {
      // const response = await fetch(this.BASE_URL + '/api/v1/collect/request', {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     Authorization: `Bearer ${this.apiKey}`,
      //   },
      //   body: JSON.stringify({
      //     startTime: request.startTime,
      //     path: request.path,
      //     duration: request.duration,
      //     method: request.method,
      //     metaData: {
      //       source: {
      //         projectSourceId: this.projectSourceId,
      //         machineName,
      //         machineIP,
      //         machineOS: machinePlatform,
      //       },
      //     },
      //   }),
      // });

      const response = await Promise.resolve({
        ok: true,
        statusText: 'OK',
      });

      if (!response.ok) {
        this.log('warn',
          '[@yelix/sdk] Failed to send request to YelixCloud:',
          response.statusText
        );
        return false;
      }

      this.log('log', 'Request sent successfully');
      return true;
    } catch (error) {
      this.log('error', 'Failed to send request:', error);
      return false;
    }
  }

  logRequest(
    request: RequestData
  ):
    | Promise<boolean>
    | ((environment: string, scheme: OpenAPICore) => Promise<boolean>) {
    this.log('log',
      `Request logged: ${request.method} ${request.path} - Duration: ${request.duration} ms`
    );

    if (this.instanceId === 'Not-Initialized') {
      this.log('log', 'YelixCloud not initialized, returning initialization function');
      return async (environment: string, scheme: OpenAPICore) => {
        await this.initialize(environment, scheme);
        // After initialization, process this request
        this.log('log', 'Adding request to queue after initialization');
        return new Promise<boolean>((resolve, reject) => {
          this.requestQueue.push({ request, resolve, reject });
          this.processQueue();
        });
      };
    }

    if (this.instanceId === 'Initializing') {
      this.log('log', 'YelixCloud initializing, queueing request');
      // Queue the request while initializing
      return new Promise<boolean>((resolve, reject) => {
        this.requestQueue.push({ request, resolve, reject });
      });
    }

    this.log('log', 'YelixCloud initialized, processing request immediately');
    // Process immediately if initialized
    return this.sendRequest(request);
  }
}
