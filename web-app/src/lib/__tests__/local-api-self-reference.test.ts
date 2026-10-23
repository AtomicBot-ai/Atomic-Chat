import { beforeEach, describe, expect, it } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  ownLocalApiServerUrl,
  pointsAtLocalApiServer,
} from '@/lib/local-api-self-reference'

const loopback = { serverHost: '127.0.0.1', serverPort: 1337, apiPrefix: '/v1' }
const lan = { ...loopback, serverHost: '0.0.0.0' }

describe('pointsAtLocalApiServer', () => {
  it.each([
    'http://127.0.0.1:1337/v1',
    'http://localhost:1337/v1',
    'http://LOCALHOST:1337',
    'http://[::1]:1337/v1',
    'http://0.0.0.0:1337/v1',
    'http://127.0.0.2:1337/anything',
    'http://[::ffff:127.0.0.1]:1337/v1',
    ' http://127.0.0.1:1337/v1/ ',
  ])('recognises %s as the server itself', (url) => {
    expect(pointsAtLocalApiServer(url, loopback)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:1338/v1',
    'http://localhost:11434/v1',
    'https://api.openai.com/v1',
    'http://192.168.1.20:1337/v1',
    'not a url',
    '',
  ])('leaves %s alone', (url) => {
    expect(pointsAtLocalApiServer(url, loopback)).toBe(false)
  })

  it('follows the configured port, not the default one', () => {
    const server = { ...loopback, serverPort: 4000 }
    expect(pointsAtLocalApiServer('http://localhost:4000/v1', server)).toBe(
      true
    )
    expect(pointsAtLocalApiServer('http://localhost:1337/v1', server)).toBe(
      false
    )
  })

  it("takes a URL without a port as the scheme's default port", () => {
    const server = { ...loopback, serverPort: 80 }
    expect(pointsAtLocalApiServer('http://localhost/v1', server)).toBe(true)
    expect(pointsAtLocalApiServer('https://localhost/v1', server)).toBe(false)
  })

  it("counts this machine's LAN address only while the server listens on it", () => {
    const addresses = ['192.168.1.5']
    expect(
      pointsAtLocalApiServer('http://192.168.1.5:1337/v1', lan, addresses)
    ).toBe(true)
    expect(
      pointsAtLocalApiServer('http://192.168.1.5:1337/v1', loopback, addresses)
    ).toBe(false)
    expect(
      pointsAtLocalApiServer('http://192.168.1.6:1337/v1', lan, addresses)
    ).toBe(false)
  })

  it('never matches a server without a fixed port yet (mobile auto-assign)', () => {
    expect(
      pointsAtLocalApiServer('http://127.0.0.1:0/v1', {
        ...loopback,
        serverPort: 0,
      })
    ).toBe(false)
  })
})

describe('ownLocalApiServerUrl', () => {
  beforeEach(() => {
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
    })
  })

  it("names the server's own address, as configured now", () => {
    useLocalApiServer.setState({ serverPort: 8123, apiPrefix: 'api' })

    expect(ownLocalApiServerUrl('http://localhost:8123/v1')).toBe(
      'http://127.0.0.1:8123/api'
    )
    expect(ownLocalApiServerUrl('http://localhost:1337/v1')).toBeUndefined()
  })

  it('dials loopback when the server listens on every interface', () => {
    useLocalApiServer.setState({ serverHost: '0.0.0.0' })

    expect(ownLocalApiServerUrl('http://10.0.0.7:1337/v1', ['10.0.0.7'])).toBe(
      'http://127.0.0.1:1337/v1'
    )
  })
})
