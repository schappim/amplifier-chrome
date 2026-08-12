# frozen_string_literal: true

require "page_inspector/version"
require "page_inspector/helper"
require "page_inspector/engine" if defined?(Rails::Engine)

# PageInspector exposes the controller#action and view/partial chain of a
# rendered page so the Shift-Click Issue Filer browser extension can report
# exactly where an element on the page came from.
#
# See extensions/rails-lib/page_inspector/README.md for setup.
module PageInspector
end
