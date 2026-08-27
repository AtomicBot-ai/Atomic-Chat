import type { MCPConnector } from '@/constants/mcp-connectors'

/**
 * 32px brand tile for a catalog connector: image asset when one exists,
 * otherwise a monogram on the connector's brand color.
 */
export function ConnectorIcon({ connector }: { connector: MCPConnector }) {
  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md"
      style={{ backgroundColor: connector.icon.bg }}
    >
      {connector.icon.src ? (
        <img
          src={connector.icon.src}
          alt={connector.name}
          className="size-full object-contain"
        />
      ) : (
        <span className="text-sm font-semibold text-white">
          {connector.name.charAt(0)}
        </span>
      )}
    </div>
  )
}
