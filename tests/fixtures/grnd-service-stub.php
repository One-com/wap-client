<?php
/**
 * Test-only stand-in for GroupOne\WapClient\GrndService: records each GRND
 * request instead of minting one, so a test can check which product and which
 * surface's credentials the auth endpoint asked for.
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

namespace GroupOne\WapClient;

final class GrndService
{
    /**
     * @param array<string, mixed> $args The arguments WapClient::get_grnd_token() received.
     *
     * @return string
     */
    public static function get_grnd(array $args)
    {
        $GLOBALS['wap_grnd_calls'][] = $args;

        return 'grnd-for-' . $args['product'];
    }
}
