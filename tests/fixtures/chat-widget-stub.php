<?php
/**
 * Test-only stand-in for GroupOne\WapClient\ChatWidget — only the one static
 * method AppPasswordScopeEnforcer calls (mcp_endpoint_url()).
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

class ChatWidget
{
    public static function mcp_endpoint_url(): string
    {
        return $GLOBALS['wap_test_mcp_endpoint'];
    }
}
