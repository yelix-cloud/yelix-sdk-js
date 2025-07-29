import type { OpenAPICore } from 'jsr:@yelix/openapi';

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

  constructor(apiKey: string, baseUrl?: string) {
    if (!apiKey) {
      throw new Error('API key is required to initialize YelixCloud');
    }
    this.apiKey = apiKey;
    if (baseUrl) {
      this.BASE_URL = baseUrl;
    }
  }

  private async initialize(environment: string, schema: OpenAPICore) {
    if (this.instanceId !== 'Not-Initialized') {
      console.warn(
        '[@yelix/sdk] YelixCloud is already initialized or in the process of initializing.'
      );
      return;
    }
    this.instanceId = 'Initializing';

    try {
      const response = await fetch(
        this.BASE_URL + '/v1/instances/create',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            environment,
            schema,
          }),
        }
      );

      if (!response.ok) {
        console.warn('[@yelix/sdk] Failed to initialize YelixCloud:', response.statusText);
        return;
      }

      const data = await response.json();
      this.instanceId = data.data.instance_id;

      // Process any queued requests
      this.processQueue();
    } catch (error) {
      console.error('Failed to initialize YelixCloud:', error);
      this.instanceId = 'Initialize-Failed';
      return;
    }
  }
  private processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const queuedRequest = this.requestQueue.shift();
      if (!queuedRequest) continue;

      // Fire and forget - don't await
      this.sendRequest(queuedRequest.request)
        .then((result) => queuedRequest.resolve(result))
        .catch((error) =>
          queuedRequest.reject(
            error instanceof Error ? error : new Error(String(error))
          )
        );
    }

    this.isProcessingQueue = false;
  }

  private async sendRequest(_request: RequestData): Promise<boolean> {
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
        console.warn(
          '[@yelix/sdk] Failed to send request to YelixCloud:',
          response.statusText
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to send request:', error);
      return false;
    }
  }

  logRequest(
    request: RequestData
  ):
    | Promise<boolean>
    | ((environment: string, scheme: OpenAPICore) => Promise<boolean>) {
    console.log(
      `Request logged: ${request.method} ${request.path} - Duration: ${request.duration} ms`
    );

    if (this.instanceId === 'Not-Initialized') {
      return async (environment: string, scheme: OpenAPICore) => {
        await this.initialize(environment, scheme);
        // After initialization, process this request
        return new Promise<boolean>((resolve, reject) => {
          this.requestQueue.push({ request, resolve, reject });
          this.processQueue();
        });
      };
    }

    if (this.instanceId === 'Initializing') {
      // Queue the request while initializing
      return new Promise<boolean>((resolve, reject) => {
        this.requestQueue.push({ request, resolve, reject });
      });
    }

    // Process immediately if initialized
    return this.sendRequest(request);
  }
}
