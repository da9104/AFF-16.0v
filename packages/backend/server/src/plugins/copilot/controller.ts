import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Req,
  Res,
  Sse,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  catchError,
  concatMap,
  connect,
  EMPTY,
  finalize,
  from,
  interval,
  map,
  merge,
  mergeMap,
  Observable,
  Subject,
  switchMap,
  takeUntil,
  toArray,
} from 'rxjs';

import { Public } from '../../core/auth';
import { CurrentUser } from '../../core/auth/current-user';
import {
  BlobNotFound,
  Config,
  CopilotFailedToGenerateText,
  CopilotSessionNotFound,
  mapSseError,
  NoCopilotProviderAvailable,
  UnsplashIsNotConfigured,
} from '../../fundamentals';
import { CopilotProviderService } from './providers';
import { ChatSession, ChatSessionService } from './session';
import { CopilotStorage } from './storage';
import { CopilotCapability, CopilotTextProvider } from './types';
import { CopilotWorkflowService, GraphExecutorState } from './workflow';

export interface ChatEvent {
  type: 'event' | 'attachment' | 'message' | 'error' | 'ping';
  id?: string;
  data: string | object;
}

type CheckResult = {
  model: string | undefined;
  hasAttachment?: boolean;
};

const PING_INTERVAL = 5000;

@Controller('/api/copilot')
export class CopilotController {
  private readonly logger = new Logger(CopilotController.name);

  constructor(
    private readonly config: Config,
    private readonly chatSession: ChatSessionService,
    private readonly provider: CopilotProviderService,
    private readonly workflow: CopilotWorkflowService,
    private readonly storage: CopilotStorage
  ) {}

  private async checkRequest(
    userId: string,
    sessionId: string,
    messageId?: string
  ): Promise<CheckResult> {
    await this.chatSession.checkQuota(userId);
    const session = await this.chatSession.get(sessionId);
    if (!session || session.config.userId !== userId) {
      throw new CopilotSessionNotFound();
    }

    const ret: CheckResult = { model: session.model };

    if (messageId && typeof messageId === 'string') {
      const message = await session.getMessageById(messageId);
      ret.hasAttachment =
        Array.isArray(message.attachments) && !!message.attachments.length;
    }

    return ret;
  }

  private async chooseTextProvider(
    userId: string,
    sessionId: string,
    messageId?: string
  ): Promise<CopilotTextProvider> {
    const { hasAttachment, model } = await this.checkRequest(
      userId,
      sessionId,
      messageId
    );
    let provider = await this.provider.getProviderByCapability(
      CopilotCapability.TextToText,
      model
    );
    // fallback to image to text if text to text is not available
    if (!provider && hasAttachment) {
      provider = await this.provider.getProviderByCapability(
        CopilotCapability.ImageToText,
        model
      );
    }
    if (!provider) {
      throw new NoCopilotProviderAvailable();
    }

    return provider;
  }

  private async appendSessionMessage(
    sessionId: string,
    messageId?: string
  ): Promise<ChatSession> {
    const session = await this.chatSession.get(sessionId);
    if (!session) {
      throw new CopilotSessionNotFound();
    }

    if (messageId) {
      await session.pushByMessageId(messageId);
    } else {
      // revert the latest message generated by the assistant
      // if messageId is not provided, then we can retry the action
      await this.chatSession.revertLatestMessage(sessionId);
      session.revertLatestMessage();
    }

    return session;
  }

  private prepareParams(params: Record<string, string | string[]>) {
    const messageId = Array.isArray(params.messageId)
      ? params.messageId[0]
      : params.messageId;
    delete params.messageId;
    return { messageId, params };
  }

  private getSignal(req: Request) {
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    return controller.signal;
  }

  private parseNumber(value: string | string[] | undefined) {
    if (!value) {
      return undefined;
    }
    const num = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
    if (Number.isNaN(num)) {
      return undefined;
    }
    return num;
  }

  private mergePingStream(
    messageId: string,
    source$: Observable<ChatEvent>
  ): Observable<ChatEvent> {
    const subject$ = new Subject();
    const ping$ = interval(PING_INTERVAL).pipe(
      map(() => ({ type: 'ping' as const, id: messageId, data: '' })),
      takeUntil(subject$)
    );

    return merge(source$.pipe(finalize(() => subject$.next(null))), ping$);
  }

  @Get('/chat/:sessionId')
  async chat(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() params: Record<string, string | string[]>
  ): Promise<string> {
    const { messageId } = this.prepareParams(params);
    const provider = await this.chooseTextProvider(
      user.id,
      sessionId,
      messageId
    );

    const session = await this.appendSessionMessage(sessionId, messageId);

    try {
      const content = await provider.generateText(
        session.finish(params),
        session.model,
        {
          ...session.config.promptConfig,
          signal: this.getSignal(req),
          user: user.id,
        }
      );

      session.push({
        role: 'assistant',
        content,
        createdAt: new Date(),
      });
      await session.save();

      return content;
    } catch (e: any) {
      throw new CopilotFailedToGenerateText(e.message);
    }
  }

  @Sse('/chat/:sessionId/stream')
  async chatStream(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() params: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    try {
      const { messageId } = this.prepareParams(params);
      const provider = await this.chooseTextProvider(
        user.id,
        sessionId,
        messageId
      );

      const session = await this.appendSessionMessage(sessionId, messageId);

      const source$ = from(
        provider.generateTextStream(session.finish(params), session.model, {
          ...session.config.promptConfig,
          signal: this.getSignal(req),
          user: user.id,
        })
      ).pipe(
        connect(shared$ =>
          merge(
            // actual chat event stream
            shared$.pipe(
              map(data => ({ type: 'message' as const, id: messageId, data }))
            ),
            // save the generated text to the session
            shared$.pipe(
              toArray(),
              concatMap(values => {
                session.push({
                  role: 'assistant',
                  content: values.join(''),
                  createdAt: new Date(),
                });
                return from(session.save());
              }),
              switchMap(() => EMPTY)
            )
          )
        ),
        catchError(mapSseError)
      );

      return this.mergePingStream(messageId, source$);
    } catch (err) {
      return mapSseError(err);
    }
  }

  @Sse('/chat/:sessionId/workflow')
  async chatWorkflow(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() params: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    try {
      const { messageId } = this.prepareParams(params);
      const session = await this.appendSessionMessage(sessionId, messageId);
      const latestMessage = session.stashMessages.findLast(
        m => m.role === 'user'
      );
      if (latestMessage) {
        params = Object.assign({}, params, latestMessage.params, {
          content: latestMessage.content,
          attachments: latestMessage.attachments,
        });
      }

      const source$ = from(
        this.workflow.runGraph(params, session.model, {
          ...session.config.promptConfig,
          signal: this.getSignal(req),
          user: user.id,
        })
      ).pipe(
        connect(shared$ =>
          merge(
            // actual chat event stream
            shared$.pipe(
              map(data => {
                switch (data.status) {
                  case GraphExecutorState.EmitContent:
                    return {
                      type: 'message' as const,
                      id: messageId,
                      data: data.content,
                    };
                  case GraphExecutorState.EmitAttachment:
                    return {
                      type: 'attachment' as const,
                      id: messageId,
                      data: data.attachment,
                    };
                  default:
                    return {
                      type: 'event' as const,
                      id: messageId,
                      data: {
                        status: data.status,
                        id: data.node.id,
                        type: data.node.config.nodeType,
                      } as any,
                    };
                }
              })
            ),
            // save the generated text to the session
            shared$.pipe(
              toArray(),
              concatMap(values => {
                session.push({
                  role: 'assistant',
                  content: values.join(''),
                  createdAt: new Date(),
                });
                return from(session.save());
              }),
              switchMap(() => EMPTY)
            )
          )
        ),
        catchError(mapSseError)
      );

      return this.mergePingStream(messageId, source$);
    } catch (err) {
      return mapSseError(err);
    }
  }

  @Sse('/chat/:sessionId/images')
  async chatImagesStream(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() params: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    try {
      const { messageId } = this.prepareParams(params);
      const { model, hasAttachment } = await this.checkRequest(
        user.id,
        sessionId,
        messageId
      );
      const provider = await this.provider.getProviderByCapability(
        hasAttachment
          ? CopilotCapability.ImageToImage
          : CopilotCapability.TextToImage,
        model
      );
      if (!provider) {
        throw new NoCopilotProviderAvailable();
      }

      const session = await this.appendSessionMessage(sessionId, messageId);

      const handleRemoteLink = this.storage.handleRemoteLink.bind(
        this.storage,
        user.id,
        sessionId
      );

      const source$ = from(
        provider.generateImagesStream(session.finish(params), session.model, {
          ...session.config.promptConfig,
          seed: this.parseNumber(params.seed),
          signal: this.getSignal(req),
          user: user.id,
        })
      ).pipe(
        mergeMap(handleRemoteLink),
        connect(shared$ =>
          merge(
            // actual chat event stream
            shared$.pipe(
              map(attachment => ({
                type: 'attachment' as const,
                id: messageId,
                data: attachment,
              }))
            ),
            // save the generated text to the session
            shared$.pipe(
              toArray(),
              concatMap(attachments => {
                session.push({
                  role: 'assistant',
                  content: '',
                  attachments: attachments,
                  createdAt: new Date(),
                });
                return from(session.save());
              }),
              switchMap(() => EMPTY)
            )
          )
        ),
        catchError(mapSseError)
      );

      return this.mergePingStream(messageId, source$);
    } catch (err) {
      return mapSseError(err);
    }
  }

  @Get('/unsplash/photos')
  async unsplashPhotos(
    @Req() req: Request,
    @Res() res: Response,
    @Query() params: Record<string, string>
  ) {
    const { unsplashKey } = this.config.plugins.copilot || {};
    if (!unsplashKey) {
      throw new UnsplashIsNotConfigured();
    }

    const query = new URLSearchParams(params);
    const response = await fetch(
      `https://api.unsplash.com/search/photos?${query}`,
      {
        headers: { Authorization: `Client-ID ${unsplashKey}` },
        signal: this.getSignal(req),
      }
    );

    res.set({
      'Content-Type': response.headers.get('Content-Type'),
      'Content-Length': response.headers.get('Content-Length'),
      'X-Ratelimit-Limit': response.headers.get('X-Ratelimit-Limit'),
      'X-Ratelimit-Remaining': response.headers.get('X-Ratelimit-Remaining'),
    });

    res.status(response.status).send(await response.json());
  }

  @Public()
  @Get('/blob/:userId/:workspaceId/:key')
  async getBlob(
    @Res() res: Response,
    @Param('userId') userId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('key') key: string
  ) {
    const { body, metadata } = await this.storage.get(userId, workspaceId, key);

    if (!body) {
      throw new BlobNotFound({
        workspaceId,
        blobId: key,
      });
    }

    // metadata should always exists if body is not null
    if (metadata) {
      res.setHeader('content-type', metadata.contentType);
      res.setHeader('last-modified', metadata.lastModified.toUTCString());
      res.setHeader('content-length', metadata.contentLength);
    } else {
      this.logger.warn(`Blob ${workspaceId}/${key} has no metadata`);
    }

    res.setHeader('cache-control', 'public, max-age=2592000, immutable');
    body.pipe(res);
  }
}