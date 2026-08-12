# frozen_string_literal: true

require_relative "lib/page_inspector/version"

Gem::Specification.new do |spec|
  spec.name        = "page_inspector"
  spec.version     = PageInspector::VERSION
  spec.authors     = ["Amplifier"]
  spec.summary     = "Expose the controller#action and view/partial chain of a page for the Amplifier Chrome extension."
  spec.description  = "A tiny Rails engine that emits controller meta tags and turns on view/partial " \
                      "annotations (in development) so a browser extension can report exactly where any " \
                      "element on the page was rendered from."
  spec.homepage    = "https://github.com/schappim/amplifier-chrome"
  spec.license     = "MIT"

  spec.required_ruby_version = ">= 3.0"

  spec.files = Dir["lib/**/*", "app/**/*", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "rails", ">= 6.1"
end
