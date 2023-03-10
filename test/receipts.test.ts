import { agentDependencies } from '@aries-framework/node'
import {
  Agent,
  ConnectionRecord,
  ConsoleLogger,
  DidExchangeState,
  EncryptedMessage,
  LogLevel,
} from '@aries-framework/core'
import { v4 as uuid } from 'uuid'
import { filter, firstValueFrom, map, ReplaySubject, Subject, timeout } from 'rxjs'
import { ReceiptsModule } from '../src/ReceiptsModule'
import { SubjectOutboundTransport } from './transport/SubjectOutboundTransport'
import { SubjectInboundTransport } from './transport/SubjectInboundTransport'
import { MessageState } from '../src/messages'
import { MessageReceiptsReceivedEvent, ReceiptsEventTypes } from '../src/services'

const logger = new ConsoleLogger(LogLevel.info)

export type SubjectMessage = { message: EncryptedMessage; replySubject?: Subject<SubjectMessage> }

describe('receipts test', () => {
  let aliceAgent: Agent<{ receipts: ReceiptsModule }>
  let bobAgent: Agent<{ receipts: ReceiptsModule }>
  let aliceWalletId: string
  let aliceWalletKey: string
  let bobWalletId: string
  let bobWalletKey: string
  let aliceConnectionRecord: ConnectionRecord
  let bobConnectionRecord: ConnectionRecord

  beforeEach(async () => {
    aliceWalletId = uuid()
    aliceWalletKey = uuid()
    bobWalletId = uuid()
    bobWalletKey = uuid()

    const aliceMessages = new Subject<SubjectMessage>()
    const bobMessages = new Subject<SubjectMessage>()

    const subjectMap = {
      'rxjs:alice': aliceMessages,
      'rxjs:bob': bobMessages,
    }

    // Initialize alice
    aliceAgent = new Agent({
      config: {
        label: 'alice',
        endpoints: ['rxjs:alice'],
        walletConfig: { id: aliceWalletId, key: aliceWalletKey },
        logger,
      },
      dependencies: agentDependencies,
      modules: { receipts: new ReceiptsModule() },
    })

    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    aliceAgent.registerInboundTransport(new SubjectInboundTransport(aliceMessages))
    await aliceAgent.initialize()

    // Initialize bob
    bobAgent = new Agent({
      config: {
        endpoints: ['rxjs:bob'],
        label: 'bob',
        walletConfig: { id: bobWalletId, key: bobWalletKey },
        logger,
      },
      dependencies: agentDependencies,
      modules: { receipts: new ReceiptsModule() },
    })

    bobAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    bobAgent.registerInboundTransport(new SubjectInboundTransport(bobMessages))
    await bobAgent.initialize()

    const outOfBandRecord = await aliceAgent.oob.createInvitation({
      autoAcceptConnection: true,
    })

    let { connectionRecord } = await bobAgent.oob.receiveInvitationFromUrl(
      outOfBandRecord.outOfBandInvitation.toUrl({ domain: 'https://example.com/ssi' }),
      { autoAcceptConnection: true }
    )

    bobConnectionRecord = await bobAgent.connections.returnWhenIsConnected(connectionRecord!.id)
    expect(bobConnectionRecord.state).toBe(DidExchangeState.Completed)

    aliceConnectionRecord = (await aliceAgent.connections.findAllByOutOfBandId(outOfBandRecord.id))[0]
    aliceConnectionRecord = await aliceAgent.connections.returnWhenIsConnected(aliceConnectionRecord!.id)
    expect(aliceConnectionRecord.state).toBe(DidExchangeState.Completed)
  })

  afterEach(async () => {
    // Wait for messages to flush out
    await new Promise((r) => setTimeout(r, 1000))

    if (aliceAgent) {
      await aliceAgent.shutdown()

      if (aliceAgent.wallet.isInitialized && aliceAgent.wallet.isProvisioned) {
        await aliceAgent.wallet.delete()
      }
    }

    if (bobAgent) {
      await bobAgent.shutdown()

      if (bobAgent.wallet.isInitialized && bobAgent.wallet.isProvisioned) {
        await bobAgent.wallet.delete()
      }
    }
  })

  test('Send a basic message receipt', async () => {
    const receiptsReceivedPromise = firstValueFrom(
      aliceAgent.events.observable<MessageReceiptsReceivedEvent>(ReceiptsEventTypes.MessageReceiptsReceived).pipe(
        filter((event: MessageReceiptsReceivedEvent) => event.payload.connectionId === aliceConnectionRecord.id),
        map((event: MessageReceiptsReceivedEvent) => event.payload.receipts),
        timeout(5000)
      )
    )

    await bobAgent.modules.receipts.send({
      connectionId: bobConnectionRecord!.id,
      receipts: [{ messageId: 'messageId', state: MessageState.Received }],
    })

    const receipts = await receiptsReceivedPromise

    expect(receipts.length).toEqual(1)
    expect(receipts[0]).toEqual(
      expect.objectContaining({
        messageId: 'messageId',
        state: MessageState.Received,
      })
    )
  })
})
