# frozen_string_literal: true

require "rails/engine"

module PageInspector
  # Wires PageInspector into a host Rails app:
  #   1. Makes the view helpers available everywhere.
  #   2. Turns on Rails' view/partial annotations (the HTML comments the
  #      extension walks to recover the partial chain) — in development only by
  #      default, so file paths never leak into production HTML.
  #
  # The engine also ships app/views/page_inspector/_meta.html.erb, which you
  # render in your layout <head>: `<%= render "page_inspector/meta" %>`.
  class Engine < ::Rails::Engine
    initializer "page_inspector.helpers" do
      ActiveSupport.on_load(:action_controller_base) do
        helper PageInspector::Helper
      end
    end

    # Enable view annotations where it's safe to expose view paths. Defaults to
    # development; force on/off with PAGE_INSPECTOR_ANNOTATE=1 / =0.
    initializer "page_inspector.annotations" do |app|
      flag = ENV["PAGE_INSPECTOR_ANNOTATE"]
      enable = flag == "1" || (flag != "0" && Rails.env.development?)
      app.config.action_view.annotate_rendered_view_with_filenames = true if enable
    end
  end
end
